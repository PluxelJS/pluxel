import { defineConfig } from 'vitest/config'
import { PLUXEL_UI_DEDUPE_PACKAGES } from '@pluxel/rolldown/workspace/vite'

export default defineConfig({
	root: import.meta.dirname,
	resolve: {
		conditions: ['development', '@pluxel/source'],
		dedupe: [...PLUXEL_UI_DEDUPE_PACKAGES],
	},
	test: {
		include: ['tests/**/*.test.{ts,tsx}'],
	},
})
