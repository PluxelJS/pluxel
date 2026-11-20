import { definePluxelVitestConfig } from '@pluxel/test/vitest'

export default definePluxelVitestConfig({
	oxc: { decorator: { legacy: true } },
	test: {
		passWithNoTests: false,
		// Each file owns Vite servers, polling watchers and native builds; bound peak memory.
		maxWorkers: 1,
	},
	pluxel: {
		include: ['tests/**/*.test.ts'],
		exclude: ['node_modules/**', 'dist/**', '**/*.d.ts', '.*/**'],
	},
})
