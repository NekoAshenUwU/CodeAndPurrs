import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const API_PORT = process.env.PORT || 8787;

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // 开发时把 /api 转给本地的呼噜代理（server/proxy.mjs）
      '/api': {
        target: `http://localhost:${API_PORT}`,
        changeOrigin: true,
      },
    },
  },
});
