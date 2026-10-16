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
		// Integration tests build real MF artifacts; upstream otherwise skips its Vite plugin.
		env: { MFE_VITE_NO_TEST_ENV_CHECK: 'true' },
		include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
		exclude: ['node_modules/**', 'dist/**', '**/*.d.ts', '.*/**'],
		passWithNoTests: false,
	},
})
