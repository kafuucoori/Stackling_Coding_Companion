import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../src-vite/features/info-panel/userMessagePresentation.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
const { presentUserMessage } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);

test('shows the actual Cursor query and folds the timestamp', () => {
  const raw = '<timestamp>Saturday, Oct 31, 2026, 4:18 PM (UTC+8)</timestamp>\n<user_query>\n你好\n</user_query>';
  const result = presentUserMessage(raw);
  assert.equal(result.body, '你好');
  assert.equal(result.context.length, 1);
  assert.equal(result.context[0].label, '时间信息');
  assert.match(result.context[0].raw, /4:18 PM/);
});

test('context-only events become compact disclosures', () => {
  for (const tag of ['environment_context', 'external_codex_apps_open_page']) {
    const raw = `<${tag}>\n原始内容\n</${tag}>`;
    const result = presentUserMessage(raw);
    assert.equal(result.body, '');
    assert.equal(result.context[0].raw, raw);
  }
});

test('keeps Markdown, Windows paths, Unicode and unknown XML', () => {
  const body = '## 修改任务\n- **保留格式** 🌸\n- `E:\\项目\\文件`\n<widget>自定义 XML</widget>';
  assert.deepEqual(presentUserMessage(body), { body, context: [] });
});

test('does not extract envelope-looking examples from fenced code', () => {
  for (const fence of ['```', '~~~']) {
    const body = `${fence}xml\n<timestamp>示例</timestamp>\n<user_query>示例</user_query>\n${fence}`;
    assert.deepEqual(presentUserMessage(body), { body, context: [] });
    const unclosed = `${fence}xml\n<timestamp>未闭合代码中的示例</timestamp>`;
    assert.deepEqual(presentUserMessage(unclosed), { body: unclosed, context: [] });
  }
});

test('preserves known tag names inside an explicit user query', () => {
  const body = '请解释 <timestamp>time</timestamp> 的含义';
  assert.deepEqual(presentUserMessage(`<user_query>${body}</user_query>`), { body, context: [] });
});

test('preserves inline XML examples and inline code', () => {
  for (const body of [
    '请解释 <timestamp>time</timestamp> 的含义',
    '`<timestamp>time</timestamp>` 是 XML 示例',
  ]) {
    assert.deepEqual(presentUserMessage(body), { body, context: [] });
  }
});

test('keeps surrounding text and all context sections in order', () => {
  const result = presentUserMessage('任务开始\n<environment_context>env</environment_context>\n<user_query>任务正文</user_query>\n<external_codex_apps_open_page>{"page_id":null}</external_codex_apps_open_page>\n补充');
  assert.match(result.body, /任务开始[\s\S]*任务正文[\s\S]*补充/);
  assert.deepEqual(result.context.map(item => item.label), ['运行环境', '页面上下文']);
});
