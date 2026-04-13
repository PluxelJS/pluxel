import { definePluxelVitestConfig } from '../test/src/vitest.ts'

export default definePluxelVitestConfig(
	{},
	{
		include: [
			'src/**/*.ts',
			'src/**/*.tsx',
			'tests/**/*.ts',
			'tests/**/*.tsx',
			'fsm/**/*.ts',
			'fsm/**/*.tsx',
			'parts/**/*.ts',
			'parts/**/*.tsx',
		],
		exclude: ['node_modules/**', 'dist/**', '**/*.d.ts', '.*/**'],
	},
)
