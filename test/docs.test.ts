// The docs must not drift from the code: every npm script they tell you to run exists in the workspace named, every
// repo path they name exists (and a `:line` is inside the file), and the ports and health response they quote are
// the code's. The parsing is in docs.ts, tested here too on the forms review 2 found slipping through.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PROTOCOL_VERSION } from '@coedit/crdt/protocol';
import { DEFAULT_HOST, DEFAULT_PORT } from '@coedit/server';
import { npmCommands, problems, repoPaths, type Manifest } from './docs.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DOCS = ['README.md', 'DESIGN.md', 'WALKTHROUGH.md'];
const read = (path: string) => readFileSync(`${ROOT}${path}`, 'utf8');

const root = JSON.parse(read('package.json')) as Manifest & { workspaces: string[] };
const workspaces = new Map(
  root.workspaces.map((dir) => {
    const m = JSON.parse(read(`${dir}/package.json`)) as Manifest;
    return [m.name, m] as const;
  }),
);
const check = (markdown: string) => problems(markdown, ROOT, root, workspaces);

describe('the docs', () => {
  for (const name of DOCS) {
    test(`${name} names only scripts and paths that exist`, () => {
      assert.deepEqual(check(read(name)), []);
    });
  }

  test('have commands and paths for the checks to read', () => {
    // So a parser that stops matching fails here instead of passing on nothing.
    const all = DOCS.map(read).join('\n');
    assert.ok(npmCommands(all).length >= 8, `${npmCommands(all).length} commands`);
    assert.ok(npmCommands(all).some((c) => c.workspace !== undefined));
    assert.ok(repoPaths(all).length >= 20, `${repoPaths(all).length} paths`);
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

describe('the checks catch', () => {
  // Each line is a doc fragment that must be reported (review 2 appended each of the first seven to README and
  // the first version of this test still passed).
  const bad = [
    '`npm -w @coedit/crdt run no-such-script`',
    '`npm run build --workspace=@coedit/crdt`',
    '`npm run build --workspace @coedit/crdt`',
    'see `packages/crdt/src/nope.ts:op`',
    'see `packages/crdt/src/nope3.ts (the reader)`',
    'a [link](packages/crdt/src/nope2.ts)',
    '| packages/crdt/src/nope4.ts | a bare path in a table |',
    '`packages/crdt/src/protocol.ts:99999`',
    '```bash\nnpm run nope -w @coedit/server\n```',
    '`npm run check && npm run nope`',
    '`npm run x -w @coedit/nope`',
    'and in prose, packages/client/src/gone.ts.',
  ];
  for (const fragment of bad) {
    test(JSON.stringify(fragment), () => {
      assert.equal(check(fragment).length, 1, JSON.stringify(check(fragment)));
    });
  }

  test('and pass what is right', () => {
    const good = [
      '`npm run harness-stats -w\n@coedit/crdt -- 2000 200`',
      '`npm start -w @coedit/server`, `npm test`, `npm ci`',
      '`packages/crdt/src/json.ts:1`, (packages/crdt/src/protocol.ts), packages/client/src/edit.ts.',
      'a glob: `packages/*/test/**/*.test.ts`',
    ];
    for (const fragment of good) assert.deepEqual(check(fragment), [], fragment);
  });
});
