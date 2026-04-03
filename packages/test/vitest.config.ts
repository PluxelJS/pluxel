import { definePluxelVitestConfig } from './src/vitest'

export default definePluxelVitestConfig(
	{},
	{
		include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
		exclude: ['node_modules/**', 'dist/**', '**/*.d.ts', '.*/**'],
		passWithNoTests: false,
	},
)
