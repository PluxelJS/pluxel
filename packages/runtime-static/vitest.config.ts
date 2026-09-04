import { definePluxelVitestConfig } from '@pluxel/test/vitest'

export default definePluxelVitestConfig({
	oxc: {
		decorator: {
			legacy: true,
		},
	},
	test: {
		include: ['tests/**/*.test.ts'],
		passWithNoTests: false,
	},
	pluxel: {
		// Semantic lowering must also cover imported fixture Plugins, not only test files.
		include: ['tests/**/*.ts'],
		exclude: ['node_modules/**', 'dist/**', '**/*.d.ts', '.*/**'],
	},
})
