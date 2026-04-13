import { definePluxelVitestConfig } from '../test/src/vitest.ts'

export default definePluxelVitestConfig(
	{},
	{
		include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
		exclude: ['node_modules/**', 'dist/**', '**/*.d.ts', '.*/**'],
		passWithNoTests: false,
	},
)
