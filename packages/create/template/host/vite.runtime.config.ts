import { defineConfig } from 'vite'
import { vitePreset } from '@pluxel/services/vite'
import { fileURLToPath } from 'node:url'

export default defineConfig({
	root: fileURLToPath(new URL('.', import.meta.url)),
	plugins: [vitePreset({ entry: fileURLToPath(new URL('./dist/app.mjs', import.meta.url)) })],
})
