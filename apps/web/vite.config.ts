import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': 'http://localhost:8787', '/kanjo': 'http://localhost:8787', '/friends': 'http://localhost:8790' } },
});
