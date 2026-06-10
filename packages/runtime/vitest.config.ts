import { resolve } from 'pathe'
import { definePluxelVitestConfig } from '@pluxel/test/vitest'

export default definePluxelVitestConfig(
	{
		resolve: {
			alias: {
				'@pluxel/runtime-dynamic/plugin': resolve(__dirname, '../runtime-dynamic/src/plugin.ts'),
			},
		},
	},
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
