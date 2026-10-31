// End-to-end: two browsers editing one document through the real sync server and the Vite dev server
// (`npm run e2e -w @coedit/client`). It uses the Chrome installed on the machine (`channel: 'chrome'`), so nothing is
// downloaded; GitHub's Ubuntu runners have Chrome installed too. Each run keeps its documents in a new temporary
// directory, and the servers are on the project's own ports (sync 8110, dev 5173), which must be free.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defineConfig } from '@playwright/test';

// Made once, in the runner: its workers load this file too, and inherit the variable.
process.env['COEDIT_E2E_DATA'] ??= fs.mkdtempSync(path.join(os.tmpdir(), 'coedit-e2e-'));
const data = process.env['COEDIT_E2E_DATA'];

export default defineConfig({
  testDir: 'e2e',
  globalTeardown: './e2e/teardown.ts',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: process.env['CI'] === undefined ? 'list' : [['list'], ['github']],
  use: { channel: 'chrome', baseURL: 'http://localhost:5173', trace: 'retain-on-failure' },
  webServer: [
    {
      command: 'npm start -w @coedit/server',
      cwd: '../..',
      env: { COEDIT_PORT: '8110', COEDIT_DATA: data },
      stdout: 'pipe',
      // The sync server answers plain HTTP on /healthz.
      url: 'http://127.0.0.1:8110/healthz',
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: 'npm run dev -w @coedit/client',
      cwd: '../..',
      url: 'http://localhost:5173',
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});
