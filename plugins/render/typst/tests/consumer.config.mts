import { definePluxelVitestConfig } from '@pluxel/test/vitest'

export default definePluxelVitestConfig({
	test: {
		include: ['tests/consumer/acceptance.ts'],
		testTimeout: 600_000,
		hookTimeout: 60_000,
	},
	pluxel: {
		include: ['src/**/*.ts', 'tests/consumer/**/*.ts'],
		exclude: ['node_modules/**', 'dist/**', '**/*.d.ts'],
	},
})
