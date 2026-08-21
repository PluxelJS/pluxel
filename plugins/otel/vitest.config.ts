import { definePluxelVitestConfig } from '@pluxel/test/vitest'

export default definePluxelVitestConfig(
	{
		test: {
			include: ['tests/**/*.test.ts', 'tests-node/**/*.test.ts'],
			exclude: ['node_modules/**', 'dist/**'],
		},
	},
	{
		include: ['src/**/*.ts', 'tests/**/*.ts'],
		exclude: ['node_modules/**', 'dist/**', '**/*.d.ts'],
		passWithNoTests: false,
	},
)
