import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In dev the UI runs on :5173 and proxies the API (server on :3000). In production the server serves ./dist itself.
const api = process.env.API_URL || 'http://localhost:3000';
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/api': api, '/openapi.json': api, '/docs': api } },
});
