import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// Test runner for the web app; build output lands in pkg/web/dist so the Go
// binary embeds it through go:embed. The dev server proxies /api at the
// service behind `make build`.
export default defineConfig({
  plugins: [react()],
  base: '/',
  build: {
    outDir: '../pkg/web/dist',
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8282',
        changeOrigin: false,
        ws: true,
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true, // lets @testing-library register automatic cleanup
    setupFiles: ['./tests/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
})
