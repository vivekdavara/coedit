// The server's command line installs its signal handlers before it prints "listening". Whoever reads that line may
// signal at once, and a signal that arrives before its handler gets the default action, which kills the process:
// main.test.ts's SIGTERM test saw exit null under the load of the whole suite (day 3). The window is too small to
// hit on purpose, so this test looks inside the child instead: a preloaded hook reports, when the line is written,
// how many handlers each signal has.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const MAIN = fileURLToPath(new URL('../src/main.ts', import.meta.url));

const PROBE = `
const write = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...rest) => {
  if (String(chunk).includes('listening on')) {
    process.stderr.write('handlers: SIGINT ' + process.listenerCount('SIGINT') + ', SIGTERM ' + process.listenerCount('SIGTERM') + '\\n');
  }
  return write(chunk, ...rest);
};
`;

test('the signal handlers are installed before the "listening" line is written', async (t) => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'coedit-test-'));
  t.after(() => {
    fs.rmSync(data, { recursive: true, force: true });
  });
  const child = spawn(
    process.execPath,
    [
      '--disable-warning=ExperimentalWarning',
      `--import=data:text/javascript,${encodeURIComponent(PROBE)}`,
      MAIN,
    ],
    {
      env: { PATH: process.env['PATH'] ?? '', COEDIT_PORT: '0', COEDIT_DATA: data },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let out = '';
  let err = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => (out += chunk));
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => (err += chunk));
  const exit = once(child, 'exit');
  try {
    const deadline = Date.now() + 10_000;
    while (!out.includes('listening on') && Date.now() < deadline && child.exitCode === null) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.match(out, /listening on/, err);
    assert.match(err, /handlers: SIGINT 1, SIGTERM 1/);
  } finally {
    child.kill('SIGKILL');
    await exit;
  }
});
