import { defineConfig } from 'vitest/config'

export default defineConfig({
	resolve: { conditions: ['development', '@pluxel/source', 'node', 'import', 'default'] },
	ssr: { resolve: { conditions: ['development', '@pluxel/source', 'node', 'import', 'default'] } },
	test: { include: ['tests/**/*.test.ts'], maxWorkers: 2 },
})
