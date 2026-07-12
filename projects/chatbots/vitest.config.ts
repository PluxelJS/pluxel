import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
	root: import.meta.dirname,
	resolve: {
		alias: [
			{
				find: /^@repo\/chatbots-access$/,
				replacement: resolve(import.meta.dirname, 'packages/access/src/index.ts'),
			},
			{
				find: /^@pluxel\/runtime$/,
				replacement: resolve(import.meta.dirname, '../../packages/runtime/dist/index.mjs'),
			},
			{
				find: /^@repo\/chatbots-contracts$/,
				replacement: resolve(import.meta.dirname, 'packages/contracts/src/index.ts'),
			},
			{
				find: /^@repo\/chatbots-hub$/,
				replacement: resolve(import.meta.dirname, 'packages/hub/src/index.ts'),
			},
			{
				find: /^@repo\/chatbots-commands$/,
				replacement: resolve(import.meta.dirname, 'packages/commands/src/index.ts'),
			},
		],
	},
	test: { include: ['packages/*/tests/**/*.test.ts'] },
})
