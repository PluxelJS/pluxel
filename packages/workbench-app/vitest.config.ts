import { defineConfig } from 'vitest/config'

export default defineConfig({
	root: import.meta.dirname,
	resolve: {
		conditions: ['development', '@pluxel/source'],
	},
	test: {
		include: ['tests/**/*.test.{ts,tsx}'],
	},
})
