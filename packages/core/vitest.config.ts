import { definePluxelVitestConfig } from '@pluxel/test/vitest'

export default definePluxelVitestConfig(
	{
		test: {
			globals: true,
			include: ['tests/**/*.test.ts', 'src/**/*.test.ts', 'fsm/tests/**/*.test.ts'],
		},
	},
	{
		include: ['packages/core/**/*.ts'],
		exclude: ['**/node_modules/**', '**/*.d.ts'],
	},
)

