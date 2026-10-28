// The server's command line: `npm start -w @coedit/server`. Settings come from the environment:
// COEDIT_HOST (default 127.0.0.1) and COEDIT_PORT (default 8110).
import { DEFAULT_HOST, DEFAULT_PORT, startServer } from './server.ts';
import { parsePort } from './config.ts';

const host = process.env['COEDIT_HOST'] ?? DEFAULT_HOST;
const portText = process.env['COEDIT_PORT'];
const port = portText === undefined ? DEFAULT_PORT : parsePort(portText);
if (port === undefined) {
  console.error(
    `COEDIT_PORT must be a port number from 0 to 65535, not ${JSON.stringify(portText)}`,
  );
  process.exit(2);
}

const server = await startServer({ host, port });
console.log(`coedit server listening on http://${server.host}:${server.port}`);

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
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
