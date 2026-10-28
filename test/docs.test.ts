// The docs must not drift from the code: every npm script they tell you to run exists, every repo path they name
// exists, and the ports and health response they quote are the code's.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PROTOCOL_VERSION } from '@coedit/crdt/protocol';
import { DEFAULT_HOST, DEFAULT_PORT } from '@coedit/server';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DOCS = ['README.md', 'DESIGN.md', 'WALKTHROUGH.md'];
const read = (path: string) => readFileSync(`${ROOT}${path}`, 'utf8');
const docs = DOCS.map((name) => ({ name, text: read(name) }));

interface Manifest {
  name: string;
  scripts?: Record<string, string>;
  workspaces?: string[];
}
const manifest = (path: string) => JSON.parse(read(path)) as Manifest;
const root = manifest('package.json');
const workspaces = new Map(
  (root.workspaces ?? []).map((dir) => {
    const m = manifest(`${dir}/package.json`);
    return [m.name, m] as const;
  }),
);

describe('the docs', () => {
  test('name only npm scripts that exist', () => {
    let checked = 0;
    for (const { name, text } of docs) {
      // Prettier may wrap an inline command across lines, so any whitespace separates the words.
      for (const match of text.matchAll(
        /npm\s+(?:run\s+([\w:-]+)|(start|test))((?:\s+-w\s+[@\w/-]+)?)/g,
      )) {
        const script = match[1] ?? match[2] ?? '';
        const workspace = /-w\s+([@\w/-]+)/.exec(match[3] ?? '')?.[1];
        const owner = workspace === undefined ? root : workspaces.get(workspace);
        assert.ok(owner !== undefined, `${name}: no workspace ${String(workspace)} (${match[0]})`);
        assert.ok(
          owner.scripts?.[script] !== undefined,
          `${name}: ${owner.name} has no script "${script}" (${match[0]})`,
        );
        checked++;
      }
    }
    assert.ok(checked >= 5, `only ${checked} commands found: is the pattern still matching?`);
  });

  test('name only repo paths that exist', () => {
    let checked = 0;
    for (const { name, text } of docs) {
      for (const match of text.matchAll(/`((?:packages|test)\/[^`\s:]+)(?::\d+)?`/g)) {
        const path = match[1] ?? '';
        assert.ok(existsSync(`${ROOT}${path}`), `${name}: ${path} does not exist`);
        checked++;
      }
    }
    assert.ok(checked >= 10, `only ${checked} paths found: is the pattern still matching?`);
  });

  test("quote the server's defaults and health response", () => {
    const readme = read('README.md');
    assert.ok(
      readme.includes(`\`${DEFAULT_HOST}:${DEFAULT_PORT}\``),
      'README: the default address',
    );
    assert.ok(
      readme.includes(`{"status":"ok","protocol":${PROTOCOL_VERSION}}`),
      'README: the health response',
    );
    assert.ok(read('DESIGN.md').includes(`port ${DEFAULT_PORT}`), 'DESIGN: the server port');
  });

  test("quote the client's dev server port", () => {
    const dev = workspaces.get('@coedit/client')?.scripts?.['dev'] ?? '';
    const port = /--port (\d+)/.exec(dev)?.[1];
    assert.ok(port !== undefined, `the dev script has no --port: ${dev}`);
    assert.ok(read('README.md').includes(`localhost:${port}`), `README: the client's port ${port}`);
  });
});
