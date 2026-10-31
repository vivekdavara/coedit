import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The page opens its sync socket on its own origin (/sync), and the dev server and `vite preview` pass it on to the
// sync server: COEDIT_SYNC_TARGET, default the server's own default address.
const target = process.env['COEDIT_SYNC_TARGET'] ?? 'ws://127.0.0.1:8110';
const proxy = { '/sync': { target, ws: true } };

export default defineConfig({
  plugins: [react()],
  server: { proxy },
  preview: { proxy },
});
