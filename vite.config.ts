/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    plugins: [react()],
    // In development the app runs on Vite and passes /api to the server, which `npm run dev` starts too.
    server: {
      proxy: { '/api': `http://localhost:${env.PORT || 8787}` },
    },
    test: {
      environment: 'jsdom',
      testTimeout: 15_000,
      setupFiles: ['./src/test/setup.ts'],
    },
  }
})
