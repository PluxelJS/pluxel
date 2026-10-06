import { definePluxelVitestConfig } from '@pluxel/test/vitest'

export default definePluxelVitestConfig({
	oxc: { decorator: { legacy: true } },
	test: {
		// Run the resource-heavy Host and Vite fixtures sequentially.
		maxWorkers: 1,
	},
})
