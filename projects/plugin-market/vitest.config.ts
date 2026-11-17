import { defineConfig } from 'vitest/config'

export default defineConfig({
	resolve: { conditions: ['@pluxel/hmr', 'module', 'browser', 'development|production'] },
	test: {
		include: ['tests/**/*.test.ts', 'web/tests/**/*.test.tsx'],
		testTimeout: 20_000,
		hookTimeout: 30_000,
	},
})
