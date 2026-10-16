import { definePluxelVitestConfig } from '@pluxel/test/vitest'

export default definePluxelVitestConfig({
	test: {
		// Integration tests build real MF artifacts; upstream otherwise skips its Vite plugin.
		env: { MFE_VITE_NO_TEST_ENV_CHECK: 'true' },
		include: ['tests/**/*.test.ts', 'tests/**/*.spec.ts'],
		exclude: ['**/node_modules/**', '**/dist/**', 'templates/**', '**/.*/**'],
	},
	pluxel: {
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
})
