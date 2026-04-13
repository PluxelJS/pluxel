import { definePluxelVitestConfig } from '../test/src/vitest.ts'

export default definePluxelVitestConfig(
	{},
	{
		include: ['src/**/*.ts', 'tests/**/*.ts'],
		exclude: ['node_modules/**', 'dist/**', '**/*.d.ts', '.*/**'],
	},
)
