import { defineConfig } from 'vitest/config'

export default defineConfig({
	test: {
		environment: 'node',
		include: ['scripts/smoke-runtime.test.mjs'],
		maxWorkers: 1,
	},
})
