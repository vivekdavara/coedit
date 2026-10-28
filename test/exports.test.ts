// Every workspace's package.json exports must name files that exist and import: nothing imports some of them yet
// (they're for the days to come), so nothing else would notice a wrong one.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const root = JSON.parse(readFileSync(`${ROOT}package.json`, 'utf8')) as { workspaces: string[] };

test('every export of every workspace exists and imports', async () => {
  let checked = 0;
  for (const dir of root.workspaces) {
    const manifest = JSON.parse(readFileSync(`${ROOT}${dir}/package.json`, 'utf8')) as {
      name: string;
      exports?: Record<string, string>;
    };
    for (const [subpath, target] of Object.entries(manifest.exports ?? {})) {
      const file = `${ROOT}${dir}/${target}`;
      assert.ok(existsSync(file), `${manifest.name} "${subpath}" -> ${target}: no such file`);
      // Import the way a dependent does, by package name, which also checks the workspace link.
      const specifier = subpath === '.' ? manifest.name : `${manifest.name}/${subpath.slice(2)}`;
      const loaded = (await import(specifier)) as Record<string, unknown>;
      const direct = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
      assert.deepEqual(Object.keys(loaded).sort(), Object.keys(direct).sort(), specifier);
      checked++;
    }
  }
  assert.ok(checked >= 3, `only ${checked} exports checked`);
});
