import { definePluxelVitestConfig } from '@pluxel/test/vitest'

export default definePluxelVitestConfig(
	{},
	{
		include: ['src/**/*.ts', 'tests/**/*.ts'],
		passWithNoTests: false,
	},
)
