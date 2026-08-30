import { definePluxelVitestConfig } from '@pluxel/test/vitest'

export default definePluxelVitestConfig(
	{},
	{
		include: ['src/demo/**/*.test.ts'],
		exclude: ['node_modules/**', 'dist/**', '**/*.d.ts'],
		passWithNoTests: false,
	},
)
