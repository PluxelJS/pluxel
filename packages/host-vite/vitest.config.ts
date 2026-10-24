import { definePluxelVitestConfig } from '@pluxel/test/vitest'

export default definePluxelVitestConfig({
	oxc: { decorator: { legacy: true } },
	test: {
		passWithNoTests: false,
		// Each file can own Vite servers, polling watchers and native build workers.
		maxWorkers: 2,
	},
	pluxel: {
		include: ['tests/**/*.test.ts'],
		exclude: ['node_modules/**', 'dist/**', '**/*.d.ts', '.*/**'],
	},
})
