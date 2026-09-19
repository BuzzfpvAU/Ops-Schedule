import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// V2 UI — a second front end against the same API. Served from /v2 in
// production; the v1 client at / is untouched.
export default defineConfig({
  base: '/v2/',
  plugins: [react()],
  server: {
    port: 5174,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
});
