import "dotenv/config"
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  root: `frontend`,
  plugins: [
    react(),
    tailwindcss(),
  ],
  build: {
    outDir: `../dist_frontend`,
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./frontend', import.meta.url))
    }
  },
  server: {
    port: Number(process.env.FRONTEND_PORT) || 5173,
    proxy: {
      "/api": {
        target: `http://localhost:${process.env.BACKEND_PORT || 3000}`,
        changeOrigin: true,
        secure: false,
      },
      "/ws": {
        target: `ws://localhost:${process.env.BACKEND_PORT || 3000}`,
        ws: true,
        changeOrigin: true,
        secure: false,
      }
    },
  },
})