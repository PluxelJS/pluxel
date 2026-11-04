import { defineConfig } from 'vitest/config'

export default defineConfig({
	test: {
		include: ['tests/**/*.test.ts', 'probes/**/*.test.ts'],
		testTimeout: 15_000,
		hookTimeout: 30_000,
	},
})
