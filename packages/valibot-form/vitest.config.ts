import react from '@vitejs/plugin-react'
import { definePluxelVitestConfig } from '@pluxel/test/vitest'

export default definePluxelVitestConfig(
	{
		test: {
			environment: 'jsdom',
		},
	},
	{
		prePlugins: [react()],
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
