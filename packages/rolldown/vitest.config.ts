import { defineConfig } from 'vitest/config'

export default defineConfig({
	resolve: {
		conditions: ['@pluxel/source', 'node', 'import', 'module', 'development', 'default'],
	},
	ssr: {
		resolve: {
			conditions: ['@pluxel/source', 'node', 'import', 'module', 'development', 'default'],
		},
	},
	test: {
		include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
		exclude: ['node_modules/**', 'dist/**', '**/*.d.ts', '.*/**'],
		passWithNoTests: false,
		deps: {
			optimizer: {
				ssr: { enabled: false },
				web: { enabled: false },
			},
		},
	},
})
