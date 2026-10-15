import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  extractDownloadedPdfAttachment,
  extractPdfAttachmentsFromText,
  extractQueuedPdfDeliveryJob,
  parseCompiledPaperPdfDeliveryCommand,
  resolveDownloadedPdfAttachmentsForQueuedJobs,
  resolveCompiledPaperPdfAttachment,
  openPdfForUpload,
} from '../../src/feishu-bridge/feishu/pdf-delivery.js';

async function createWorkspaceDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'feishu-pdf-delivery-'));
}

test('PDF extraction rejects host paths, sibling prefixes and traversal', () => {
  assert.deepEqual(extractPdfAttachmentsFromText(
    '/etc/private.pdf /tmp/workspace-other/private.pdf knowledge-base/../../../private.pdf',
    '/tmp/workspace',
  ), []);
  for (const filePath of ['/etc/private.pdf', '../private.pdf', '/tmp/workspace-other/private.pdf']) {
    assert.equal(extractDownloadedPdfAttachment({
      type: 'tool_execution_end', toolName: 'download_paper',
      result: { details: { status: 'downloaded', path: filePath } },
    }, '/tmp/workspace'), null);
  }
  assert.equal(resolveCompiledPaperPdfAttachment({ dir: '/tmp/paper', compiledPdfPath: '../private.pdf' }), null);
});

test('PDF upload validates real paths and reads only a bounded workspace file', async () => {
  const workspace = await createWorkspaceDir();
  const outside = await createWorkspaceDir();
  try {
    const safe = path.join(workspace, 'safe.pdf');
    const secret = path.join(outside, 'secret.pdf');
    await writeFile(safe, '%PDF-safe');
    await writeFile(secret, '%PDF-secret');
    await assert.rejects(openPdfForUpload(secret, [workspace], 100), /outside/);
    await assert.rejects(openPdfForUpload(safe, [workspace], 1), /size limit/);
    await mkdir(path.join(workspace, 'directory.pdf'));
    await assert.rejects(openPdfForUpload(path.join(workspace, 'directory.pdf'), [workspace], 100), /regular file/);
    const file = await openPdfForUpload(safe, [workspace, path.join(workspace, 'missing-root')], 100);
    try { assert.equal(await file.readFile('utf8'), '%PDF-safe'); }
    finally { await file.close(); }
    // Both direct and parent-directory symlinks must be checked at upload time.
    if (process.platform !== 'win32') {
      await symlink(secret, path.join(workspace, 'link.pdf'));
      await symlink(outside, path.join(workspace, 'linked-directory'));
      for (const target of ['link.pdf', 'linked-directory/secret.pdf']) {
        await assert.rejects(openPdfForUpload(path.join(workspace, target), [workspace], 100), /symlink escapes/);
      }
      await symlink(safe, path.join(workspace, 'safe-link.pdf'));
      const linked = await openPdfForUpload(path.join(workspace, 'safe-link.pdf'), [workspace], 100);
      await linked.close();
    }
    // An explicitly configured paper workspace can be outside the bridge cwd.
    const paper = await openPdfForUpload(secret, [workspace, outside], 100);
    await paper.close();
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('extractDownloadedPdfAttachment resolves successful download_paper results', () => {
  const attachment = extractDownloadedPdfAttachment(
    {
      type: 'tool_execution_end',
      toolName: 'download_paper',
      isError: false,
      result: {
        details: {
          status: 'downloaded',
          source: 'arxiv',
          canonicalId: '2401.01234',
          articleUrl: 'https://arxiv.org/abs/2401.01234',
          path: 'knowledge-base/raw/pdfs/arxiv-2401.01234.pdf',
        },
      },
    },
    '/tmp/workspace',
  );

  assert.deepEqual(attachment, {
    path: path.join('/tmp/workspace', 'knowledge-base/raw/pdfs/arxiv-2401.01234.pdf'),
    fileName: 'arxiv-2401.01234.pdf',
    status: 'downloaded',
    source: 'arxiv',
    canonicalId: '2401.01234',
    articleUrl: 'https://arxiv.org/abs/2401.01234',
  });
});

test('extractDownloadedPdfAttachment ignores queued or non-PDF results', () => {
  assert.equal(
    extractDownloadedPdfAttachment(
      {
        type: 'tool_execution_end',
        toolName: 'download_paper',
        isError: false,
        result: {
          details: {
            status: 'extension_job_queued',
            path: 'knowledge-base/raw/pdfs/pending.pdf',
          },
        },
      },
      '/tmp/workspace',
    ),
    null,
  );

  assert.equal(
    extractDownloadedPdfAttachment(
      {
        type: 'tool_execution_end',
        toolName: 'download_paper',
        isError: false,
        result: {
          details: {
            status: 'downloaded',
            path: 'knowledge-base/sources/arxiv-2401.01234/acquisition.json',
          },
        },
      },
      '/tmp/workspace',
    ),
    null,
  );
});

test('extractQueuedPdfDeliveryJob reads extension jobs from download_paper results', () => {
  assert.deepEqual(
    extractQueuedPdfDeliveryJob({
      type: 'tool_execution_end',
      toolName: 'download_paper',
      isError: false,
      result: {
        details: {
          status: 'extension_job_queued',
          source: 'nature',
          articleUrl: 'https://www.nature.com/articles/s41586-025-09061-4',
          jobId: 'paper-nature-1',
        },
      },
    }),
    {
      jobId: 'paper-nature-1',
      source: 'nature',
      articleUrl: 'https://www.nature.com/articles/s41586-025-09061-4',
    },
  );
});

test('extractPdfAttachmentsFromText resolves PDF paths in final replies', () => {
  const attachments = extractPdfAttachmentsFromText(
    [
      '本地 PDF 路径：`\\\\wsl.localhost\\Ubuntu-24.04\\home\\ququan2\\pi-agent-minimal-ts\\knowledge-base\\raw\\pdfs\\nature-s41586-025-09061-4.pdf`',
      '备用：knowledge-base/raw/pdfs/arxiv-2401.01234.pdf',
      '论文：paper-projects/million-superconducting-qubits/manuscript/main.pdf',
      '解析文本：knowledge-base/sources/nature/parses/webpage/document.md',
    ].join('\n'),
    '/home/ququan2/pi-agent-minimal-ts',
  );

  assert.deepEqual(attachments, [
    {
      path: '/home/ququan2/pi-agent-minimal-ts/knowledge-base/raw/pdfs/nature-s41586-025-09061-4.pdf',
      fileName: 'nature-s41586-025-09061-4.pdf',
      status: 'already_downloaded',
    },
    {
      path: '/home/ququan2/pi-agent-minimal-ts/knowledge-base/raw/pdfs/arxiv-2401.01234.pdf',
      fileName: 'arxiv-2401.01234.pdf',
      status: 'already_downloaded',
    },
    {
      path: '/home/ququan2/pi-agent-minimal-ts/paper-projects/million-superconducting-qubits/manuscript/main.pdf',
      fileName: 'main.pdf',
      status: 'already_downloaded',
    },
  ]);
});

test('parseCompiledPaperPdfDeliveryCommand recognizes compiled paper PDF send requests', () => {
  assert.equal(parseCompiledPaperPdfDeliveryCommand('@_user_1 把编译后的论文发给我'), true);
  assert.equal(parseCompiledPaperPdfDeliveryCommand('对，把这个论文发给我'), true);
  assert.equal(parseCompiledPaperPdfDeliveryCommand('send me the compiled paper pdf'), true);
  assert.equal(parseCompiledPaperPdfDeliveryCommand('论文 git status'), false);
  assert.equal(parseCompiledPaperPdfDeliveryCommand('怎么把论文发给别人'), false);
});

test('resolveCompiledPaperPdfAttachment resolves configured paper PDF path', () => {
  assert.deepEqual(
    resolveCompiledPaperPdfAttachment({
      dir: '/tmp/paper',
      compiledPdfPath: 'output/paper.pdf',
    }),
    {
      path: '/tmp/paper/output/paper.pdf',
      fileName: 'paper.pdf',
      status: 'already_downloaded',
      source: 'paper_workspace',
    },
  );

  assert.equal(resolveCompiledPaperPdfAttachment({ dir: '/tmp/paper', compiledPdfPath: 'main.tex' }), null);
  assert.equal(resolveCompiledPaperPdfAttachment({ compiledPdfPath: 'main.pdf' }), null);
});

test('extractPdfAttachmentsFromText handles JSON-escaped WSL paths', () => {
  assert.deepEqual(
    extractPdfAttachmentsFromText(
      String.raw`本地 PDF 路径：\\wsl.localhost\\Ubuntu-24.04\\home\\ququan2\\pi-agent-minimal-ts\\knowledge-base\\raw\\pdfs\\nature-s41586-025-09061-4.pdf`,
      '/home/ququan2/pi-agent-minimal-ts',
    ),
    [
      {
        path: '/home/ququan2/pi-agent-minimal-ts/knowledge-base/raw/pdfs/nature-s41586-025-09061-4.pdf',
        fileName: 'nature-s41586-025-09061-4.pdf',
        status: 'already_downloaded',
      },
    ],
  );
});

test('resolveDownloadedPdfAttachmentsForQueuedJobs finds completed extension downloads', async () => {
  const workspaceDir = await createWorkspaceDir();
  try {
    const jobsPath = path.join(workspaceDir, '.browser-profile', 'paper-download-jobs.jsonl');
    await mkdir(path.dirname(jobsPath), { recursive: true });
    await writeFile(
      jobsPath,
      [
        JSON.stringify({
          jobId: 'paper-nature-1',
          recordedAt: '2026-05-06T02:19:43.152Z',
          status: 'queued',
          articleUrl: 'https://www.nature.com/articles/s41586-025-09061-4',
          source: 'nature',
        }),
        JSON.stringify({
          jobId: 'paper-nature-1',
          recordedAt: '2026-05-06T02:20:43.817Z',
          status: 'downloaded',
          articleUrl: 'https://www.nature.com/articles/s41586-025-09061-4',
          source: 'nature',
          downloadPath: path.join(workspaceDir, 'knowledge-base/raw/pdfs/nature-s41586-025-09061-4.pdf'),
        }),
        '',
      ].join('\n'),
      'utf8',
    );

    assert.deepEqual(
      await resolveDownloadedPdfAttachmentsForQueuedJobs(workspaceDir, [{ jobId: 'paper-nature-1' }]),
      [
        {
          path: path.join(workspaceDir, 'knowledge-base/raw/pdfs/nature-s41586-025-09061-4.pdf'),
          fileName: 'nature-s41586-025-09061-4.pdf',
          status: 'downloaded',
          source: 'nature',
          articleUrl: 'https://www.nature.com/articles/s41586-025-09061-4',
        },
      ],
    );
  } finally {
    await rm(workspaceDir, { recursive: true, force: true });
  }
});
