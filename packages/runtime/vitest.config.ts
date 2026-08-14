import { definePluxelVitestConfig } from '@pluxel/test/vitest'
import { fileURLToPath } from 'node:url'

export default definePluxelVitestConfig(
	{
		resolve: {
			alias: {
				'@worksplit/react/style.css': fileURLToPath(
					new URL('../../vendor/split-like-vscode/packages/react/src/style.css', import.meta.url),
				),
			},
		},
		oxc: {
			decorator: {
				legacy: true,
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
