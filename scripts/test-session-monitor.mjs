import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

test('a closure update during an in-flight fetch schedules another refresh', async () => {
  const handlers = new Map();
  const pending = [];
  const snapshots = [];
  globalThis.__stacklingMonitorTest = {
    invoke: () => new Promise(resolve => pending.push(resolve)),
    listen: async (event, callback) => {
      handlers.set(event, callback);
      return () => handlers.delete(event);
    },
  };
  const input = await readFile(new URL('../src-vite/features/agent-monitor/agentMonitor.ts', import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(input, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
  const source = outputText.replace(/import \{ (invoke|listen) \} from ['"][^'"]+['"];?/g,
    (_, name) => `const ${name} = globalThis.__stacklingMonitorTest.${name};`);
  const { startSessionMonitor } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  const stop = startSessionMonitor({ onSessions: value => snapshots.push(value) }, { intervalMs: 60000 });
  try {
    assert.equal(pending.length, 1);
    handlers.get('claude-session-update')();
    pending.shift()([{ sessionId: 'closing', status: 'processing' }]);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(pending.length, 1, 'the closure event must not be lost while busy');
    pending.shift()([]);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(snapshots.at(-1), []);
  } finally {
    stop();
    await new Promise(resolve => setImmediate(resolve));
    delete globalThis.__stacklingMonitorTest;
  }
});
