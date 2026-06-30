import { describe, expect, it } from 'vitest'

import {
	buildLoaderHmrViteConfig,
	resolveLoaderHmrDependencyConfig,
} from '../../src/hmr/engine/config'

describe('HMR client optimizeDeps', () => {
	it('optimizes explicit browser entries outside the Vite root', () => {
		const config = buildLoaderHmrViteConfig({
			root: '/tmp/pluxel-runtime',
			fsAllow: [],
			clientEntries: ['/workspace/packages/runtime/src/client.tsx'],
			deps: resolveLoaderHmrDependencyConfig(),
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

	it('merges user Vite config as the final layer while keeping internal plugins', () => {
		const config = buildLoaderHmrViteConfig({
			root: '/tmp/pluxel-runtime',
			fsAllow: [],
			deps: resolveLoaderHmrDependencyConfig(),
			runnerPlugin: { name: 'runner-noop' },
			httpPlugin: { name: 'http-noop' },
			port: 3210,
			vite: {
				server: {
					port: 4321,
				},
				define: {
					__PLUXEL_TEST_MARKER__: JSON.stringify('user-config'),
				},
				plugins: [{ name: 'user-vite-plugin' }],
			},
		})

		expect(config.server?.port).toBe(4321)
		expect(config.define).toMatchObject({
			__PLUXEL_TEST_MARKER__: JSON.stringify('user-config'),
		})
		expect((config.plugins ?? []).map((plugin) => (plugin as { name?: string }).name)).toEqual(
			expect.arrayContaining([
				'pluxel:client-node-import-guard',
				'runner-noop',
				'http-noop',
				'user-vite-plugin',
			]),
		)
	})
})
