// Removes the run's document directory (playwright.config.ts) once the servers have stopped.
import fs from 'node:fs';

export default function teardown(): void {
  const data = process.env['COEDIT_E2E_DATA'];
  if (data !== undefined) fs.rmSync(data, { recursive: true, force: true });
}
