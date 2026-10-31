// Review 2 of day 3's fixes: 692bb29 refuses upper-case hosts because no browser sends them, but still accepts other
// origins no browser sends.
//
// What is wrong: parseOrigins (config.ts) now refuses `http://LOCALHOST:5173` because "a browser sends the host
// lower-cased, so it could never match" and the page would get 403 with no hint why. By the same rule a browser
// never sends a scheme's default port (RFC 6454 serializes `https://editor.test:443` as `https://editor.test`), nor an
// IPv6 address other than in its canonical, compressed form (`[::1]`, never `[0:0:0:0:0:0:0:1]`), nor an IPv4 address
// in any other form than dotted decimal (`127.1` is sent as `127.0.0.1`). The pattern accepts all of these, and an
// allow-list entry written that way silently refuses the page it was meant for.
//
// Right behaviour: an origin that a browser could never send is refused at startup like the upper-case host (exit 2
// with the usage message); or the setting is canonicalized (new URL(origin).origin gives what a browser sends).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseOrigins } from '../src/config.ts';

for (const origin of [
  'http://localhost:80',
  'https://editor.test:443',
  'http://[0:0:0:0:0:0:0:1]:5173',
  'http://127.1:5173',
]) {
  test(`${origin}, which no browser sends, is refused (or canonicalized)`, () => {
    const parsed = parseOrigins(origin);
    // What a browser would send for a page at this origin.
    const sent = new URL(origin).origin;
    assert.notEqual(sent, origin);
    assert.ok(
      parsed === undefined || parsed[0] === sent,
      `accepted as ${JSON.stringify(parsed)}, but a browser sends ${sent}`,
    );
  });
}
