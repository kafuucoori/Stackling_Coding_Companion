// Windows hook transport regressions. No agent installation or user config is changed.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

assert.equal(process.platform, 'win32', 'Hook scripts require Windows PowerShell');
const root = fileURLToPath(new URL('../', import.meta.url));
const temp = await mkdtemp(path.join(os.tmpdir(), 'stackling-hook-test-'));

async function run(script, payload, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
    ], { windowsHide: true, env: { ...process.env, ...extraEnv } });
    const stdout = [];
    const stderr = [];
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Hook exceeded 3 seconds')); }, 3000);
    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', code => {
      clearTimeout(timeout);
      try {
        assert.equal(code, 0, Buffer.concat(stderr).toString());
        const bytes = Buffer.concat(stdout);
        assert.notEqual(bytes.subarray(0, 3).toString('hex'), 'efbbbf', 'stdout must not have a BOM');
        resolve(JSON.parse(bytes.toString('utf8')));
      } catch (error) { reject(error); }
    });
    child.stdin.end(payload);
  });
}

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

try {
  const claudeRust = await readFile(path.join(root, 'src-tauri/src/claude_hooks.rs'), 'utf8');
  const claudeScript = claudeRust.match(/const HOOK_SCRIPT: &str = r#"([\s\S]*?)"#;/)[1];
  const claudePath = path.join(temp, 'claude.ps1');
  await writeFile(claudePath, claudeScript);
  assert.deepEqual(await run(claudePath, '{"hook_event_name":"sessionEnd"}', { CURSOR_VERSION: 'test' }), {});
  console.log('claude: Cursor-imported calls exit with empty JSON before process discovery');
  for (const source of ['codex', 'cursor']) {
    const rust = await readFile(path.join(root, `src-tauri/src/${source}_hooks.rs`), 'utf8');
    const script = rust.match(/const HOOK_SCRIPT: &str = r#"([\s\S]*?)"#;/)[1];
    const scriptPath = path.join(temp, `${source}.ps1`);
    const received = [];
    const server = net.createServer({ allowHalfOpen: true }, socket => {
      let bytes = '';
      socket.setEncoding('utf8');
      socket.on('data', chunk => { bytes += chunk; });
      socket.on('end', () => {
        const event = JSON.parse(bytes);
        received.push(event);
        socket.end(event.hook_event_name === 'PermissionRequest'
          ? JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: '测试拒绝' } } })
          : '');
      });
    });
    const port = await listen(server);
    await writeFile(scriptPath, script.replaceAll(source === 'codex' ? '19283' : '19284', String(port)));
    try {
      const event = { session_id: 'test', hook_event_name: source === 'codex' ? 'SessionStart' : 'afterAgentThought', source: 'fork', cwd: 'E:\\项目\\测试', text: '中文 🌸' };
      assert.deepEqual(await run(scriptPath, '\uFEFF  ' + JSON.stringify(event)), {});
      // Cursor responds on stdout before forwarding; wait for the child to exit
      // and for the mock server to consume the final TCP bytes.
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(received[0].cwd, event.cwd);
      assert.equal(received[0].text, event.text);
      assert.equal(received[0].source, 'fork');
      if (source === 'codex') {
        assert.equal(received[0].stackling_source, 'codex');
        const response = await run(scriptPath, JSON.stringify({ ...event, hook_event_name: 'PermissionRequest' }));
        assert.equal(response.hookSpecificOutput.decision.message, '测试拒绝');
      } else {
        // Simulate Cursor's local execution host, including an actual PowerShell
        // DateTime, without launching Cursor or querying unrelated processes.
        const hostFixture = `function Get-CimInstance { param($ClassName, $Filter)
          if ($Filter -eq "ProcessId=$PID") { return [pscustomobject]@{ ParentProcessId = 98765 } }
          return [pscustomobject]@{ ProcessId = 98765; Name = 'Cursor.exe'; CommandLine = '--type=utility --utility-sub-type=node.mojom.NodeService'; CreationDate = [datetime]::Parse('2026-10-31T00:00:00Z').ToUniversalTime() }
        }\n`;
        const instrumented = script.replaceAll('19284', String(port));
        await writeFile(scriptPath, hostFixture + instrumented);
        assert.deepEqual(await run(scriptPath, JSON.stringify({ ...event, hook_event_name: 'beforeSubmitPrompt' })), {});
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(received.at(-1).cursor_host_pid, 98765);
        assert.equal(received.at(-1).cursor_host_created_ms, Date.parse('2026-10-31T00:00:00Z') + 11644473600000);
        await writeFile(scriptPath, instrumented);
      }
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
    // Reuse the now-closed port to exercise connection-refused fallback.
    assert.deepEqual(await run(scriptPath, '{"hook_event_name":"Stop","session_id":"offline"}'), {});
    assert.deepEqual(await run(scriptPath, ''), {});
    console.log(`${source}: UTF-8/BOM, forwarding, offline and empty-input checks passed`);
  }
} finally {
  await rm(temp, { recursive: true, force: true });
}
