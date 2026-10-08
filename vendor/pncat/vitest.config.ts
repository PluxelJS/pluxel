import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'
export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)), pncat: fileURLToPath(new URL('./src/index.ts', import.meta.url)) } },
  test: { include: ['test/**/*.test.ts'] },
})
