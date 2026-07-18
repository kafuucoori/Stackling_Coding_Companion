// vite.config.ts —— 固定端口 5230，产物输出到 dist；@ 别名指向 src-vite/。
import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src-vite', import.meta.url)),
    },
  },
  server: {
    port: 5230,
    strictPort: true,
  },
  build: {
    target: 'esnext',
    outDir: 'dist',
  },
})
