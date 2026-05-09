import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  extractDownloadedPdfAttachment,
  extractPdfAttachmentsFromText,
  extractQueuedPdfDeliveryJob,
  parseCompiledPaperPdfDeliveryCommand,
  resolveDownloadedPdfAttachmentsForQueuedJobs,
  resolveCompiledPaperPdfAttachment,
} from '../../src/feishu-bridge/feishu/pdf-delivery.js';

async function createWorkspaceDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'feishu-pdf-delivery-'));
}

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
          downloadPath: String.raw`\\wsl.localhost\Ubuntu-24.04\home\ququan2\pi-agent-minimal-ts\knowledge-base\raw\pdfs\nature-s41586-025-09061-4.pdf`,
        }),
        '',
      ].join('\n'),
      'utf8',
    );

    assert.deepEqual(
      await resolveDownloadedPdfAttachmentsForQueuedJobs(workspaceDir, [{ jobId: 'paper-nature-1' }]),
      [
        {
          path: '/home/ququan2/pi-agent-minimal-ts/knowledge-base/raw/pdfs/nature-s41586-025-09061-4.pdf',
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
