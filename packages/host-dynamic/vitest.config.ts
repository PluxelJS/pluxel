import { defineConfig } from 'vitest/config'
export default defineConfig({
	resolve: { conditions: ['@pluxel/source'] },
	test: { environment: 'node' },
})
