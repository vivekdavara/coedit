// The server's command line: `npm start -w @coedit/server`. Settings come from the environment:
// COEDIT_HOST (default 127.0.0.1), COEDIT_PORT (default 8110), and COEDIT_ORIGINS (the web origins whose pages may
// connect, separated by commas; default the client's dev server, http://localhost:5173 and http://127.0.0.1:5173).
import {
  DEFAULT_HOST,
  DEFAULT_ORIGINS,
  DEFAULT_PORT,
  startServer,
  type SyncServer,
} from './server.ts';
import { hostPort, parseOrigins, parsePort } from './config.ts';

const host = process.env['COEDIT_HOST'] ?? DEFAULT_HOST;
if (host === '') {
  // Node reads an empty host as "every interface", which is not what an empty setting should mean.
  console.error('COEDIT_HOST must not be empty (unset it for 127.0.0.1)');
  process.exit(2);
}
const portText = process.env['COEDIT_PORT'];
const port = portText === undefined ? DEFAULT_PORT : parsePort(portText);
if (port === undefined) {
  console.error(
    `COEDIT_PORT must be a port number from 0 to 65535, not ${JSON.stringify(portText)}`,
  );
  process.exit(2);
}

const originsText = process.env['COEDIT_ORIGINS'];
const origins = originsText === undefined ? DEFAULT_ORIGINS : parseOrigins(originsText);
if (origins === undefined) {
  console.error(
    `COEDIT_ORIGINS must be origins like http://localhost:5173, separated by commas, not ${JSON.stringify(originsText)}`,
  );
  process.exit(2);
}

let server: SyncServer;
try {
  server = await startServer({ host, port, origins });
} catch (error) {
  console.error(`can't listen on ${hostPort(host, port)}: ${(error as Error).message}`);
  process.exit(1);
}
let stopping = false;
const stop = (signal: NodeJS.Signals) => {
  if (stopping) {
    // A second Ctrl-C means "now": don't wait for the close.
    console.error(`${signal} again: exiting without waiting`);
    process.exit(130);
  }
  stopping = true;
  console.log(`${signal}: closing`);
  server.close().then(
    () => process.exit(0),
    (error: unknown) => {
      console.error('close failed:', error);
      process.exit(1);
    },
  );
};
// Before the "listening" line, not after: whoever reads that line may signal at once, and a signal arriving before
// its handler is installed gets the default action, which kills the process (the SIGTERM test saw it under load).
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
console.log(`coedit server listening on http://${hostPort(server.host, server.port)}`);
