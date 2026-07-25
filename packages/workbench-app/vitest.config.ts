import { defineConfig } from 'vitest/config'

export default defineConfig({
	root: import.meta.dirname,
	resolve: {
		conditions: ['@pluxel/source'],
	},
	test: {
		include: ['tests/**/*.test.ts'],
	},
})
