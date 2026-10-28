// Review 1: the server's host default. `COEDIT_HOST=` (set but empty) reached startServer as '', `??` kept it, and
// listen(port, '') bound '::', every interface. main.ts refuses it too, with a friendlier message.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startServer } from '../src/server.ts';

test('an empty host is refused rather than binding every interface', async () => {
  // If the check regresses the server starts; close it, or the test file waits on it forever (review 2).
  let error: unknown;
  try {
    const server = await startServer({ host: '', port: 0 });
    await server.close();
  } catch (caught) {
    error = caught;
  }
  assert.match(String(error), /the host must not be empty/);
});
