import { describe, expect, it } from 'vitest'

import { buildHmrViteConfig, resolveHMRDependencyConfig } from '@pluxel/hmr'

describe('HMR client optimizeDeps', () => {
	it('optimizes explicit browser entries outside the Vite root', () => {
		const config = buildHmrViteConfig({
			root: '/tmp/pluxel-hmr',
			fsAllow: [],
			clientEntries: ['/workspace/packages/runtime/src/client.tsx'],
			deps: resolveHMRDependencyConfig(),
			runnerPlugin: { name: 'runner-noop' },
			httpPlugin: { name: 'http-noop' },
		})

		expect(config.optimizeDeps).toMatchObject({
			entries: ['/workspace/packages/runtime/src/client.tsx'],
			needsInterop: ['react', 'react-dom'],
		})
		expect((config.optimizeDeps as { include?: string[] }).include).toEqual(
			expect.arrayContaining(['react', 'react-dom/client', '@tabler/icons-react']),
		)

		const resolveConfig = config.resolve as {
			alias?: Array<{ find: RegExp; replacement: string }>
		}
		expect(resolveConfig.alias).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					find: /^@tabler\/icons-react$/,
				}),
			]),
		)
		expect(resolveConfig.alias?.[0]?.replacement).toContain('@tabler/icons-react')
		expect(resolveConfig.alias?.[0]?.replacement).toContain('index.mjs')
	})
})
