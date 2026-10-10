import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// `pnpm --filter @codewalk/web dev` proxies the API to a running `walk serve` (default port).
export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: { proxy: { '/api': { target: 'http://127.0.0.1:4321', changeOrigin: true } } },
});
