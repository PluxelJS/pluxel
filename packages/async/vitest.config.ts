import { defineConfig } from 'vitest/config'

const conditions = ['@pluxel/source', 'node', 'import', 'default']

export default defineConfig({
	resolve: {
		conditions,
		externalConditions: conditions,
	},
	ssr: {
		resolve: {
			conditions,
			externalConditions: conditions,
		},
	},
	test: {
		passWithNoTests: false,
		typecheck: { enabled: true },
	},
})
