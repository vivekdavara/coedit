// Review 1: the server's host default. `COEDIT_HOST=` (set but empty) reached startServer as '', `??` kept it, and
// listen(port, '') bound '::', every interface. main.ts refuses it too, with a friendlier message.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startServer } from '../src/server.ts';

test('an empty host is refused rather than binding every interface', async () => {
  await assert.rejects(startServer({ host: '', port: 0 }), /the host must not be empty/);
});
