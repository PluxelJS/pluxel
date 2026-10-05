import { defineConfig } from 'vite'
import { vitePreset } from '@pluxel/services/vite'

export default defineConfig({
	root: import.meta.dirname,
	plugins: [vitePreset({ entry: 'dist/app.mjs' })],
})
