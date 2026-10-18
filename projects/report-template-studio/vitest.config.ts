import { definePluxelVitestConfig } from '@pluxel/test/vitest'
export default definePluxelVitestConfig({
	test: {
		// Files start real Hosts, native Typst workers and QuickJS heaps.
		maxWorkers: 2,
		include: ['tests/**/*.test.{ts,tsx}'],
		testTimeout: 60000,
		hookTimeout: 60000,
	},
	pluxel: { include: ['src/**/*.ts', 'tests/**/*.ts'] },
})
