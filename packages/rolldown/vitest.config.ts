import { defineConfig } from 'vitest/config'

export default defineConfig({
	resolve: {
		conditions: ['development', '@pluxel/source', 'node', 'import', 'module', 'default'],
	},
	ssr: {
		resolve: {
			conditions: ['development', '@pluxel/source', 'node', 'import', 'module', 'default'],
		},
	},
	test: {
		include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
		exclude: ['node_modules/**', 'dist/**', '**/*.d.ts', '.*/**'],
		passWithNoTests: false,
	},
})
