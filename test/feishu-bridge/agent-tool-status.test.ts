import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAgentToolProgressText,
  formatAgentToolStatus,
} from '../../src/feishu-bridge/agent-tool-status.js';

test('formatAgentToolStatus shows workspace file tool starts', () => {
  const status = formatAgentToolStatus({
    type: 'tool_execution_start',
    toolName: 'replace_file_text',
    args: {
      path: 'paper-projects/demo/manuscript/main.tex',
    },
  });

  assert.equal(status?.phase, 'start');
  assert.equal(status?.toolName, 'replace_file_text');
  assert.match(status?.text ?? '', /开始修改文件/);
  assert.match(status?.text ?? '', /main\.tex/);
});

test('formatAgentToolStatus shows wiki tool progress messages', () => {
  const status = formatAgentToolStatus({
    type: 'tool_execution_update',
    toolName: 'build_wiki_page',
    partialResult: {
      content: [{ type: 'text', text: 'Writing wiki page for superconducting qubits.' }],
      details: {
        progress: {
          message: 'Writing page knowledge-base/wiki/pages/superconducting-qubits.md.',
        },
      },
    },
  });

  assert.equal(status?.phase, 'progress');
  assert.match(status?.text ?? '', /生成 wiki 页面中/);
  assert.match(status?.text ?? '', /superconducting-qubits\.md/);
});

test('formatAgentToolStatus ignores tools that are not useful card progress', () => {
  assert.equal(formatAgentToolStatus({
    type: 'tool_execution_start',
    toolName: 'get_time',
    args: {},
  }), null);
});

test('buildAgentToolProgressText keeps recent tool status lines', () => {
  const text = buildAgentToolProgressText([
    {
      phase: 'start',
      toolName: 'read_file',
      text: '开始读取文件：README.md',
      isError: false,
    },
    {
      phase: 'end',
      toolName: 'read_file',
      text: '完成读取文件：README.md',
      isError: false,
    },
    {
      phase: 'end',
      toolName: 'delete_file',
      text: '失败删除文件：old.md',
      isError: true,
    },
  ]);

  assert.match(text, /正在执行工具/);
  assert.match(text, /\[\.\.\.\] 开始读取文件/);
  assert.match(text, /\[ok\] 完成读取文件/);
  assert.match(text, /\[error\] 失败删除文件/);
});
