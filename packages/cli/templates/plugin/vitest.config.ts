import { definePluxelVitestConfig } from '@pluxel/test/vitest'

export default definePluxelVitestConfig({
	test: {
		passWithNoTests: false,
	},
	pluxel: {
		include: ['src/**/*.ts', 'src/**/*.tsx', 'tests/**/*.ts', 'tests/**/*.tsx'],
		exclude: ['node_modules/**', 'dist/**', '**/*.d.ts'],
	},
})
