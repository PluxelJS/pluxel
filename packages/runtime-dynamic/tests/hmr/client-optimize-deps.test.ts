import { describe, expect, it } from 'vitest'

import { buildLoaderHmrViteConfig } from '../../src/hmr/engine/config'

describe('HMR client optimizeDeps', () => {
	it('optimizes explicit browser entries outside the Vite root', () => {
		const config = buildLoaderHmrViteConfig({
			root: '/tmp/pluxel-runtime',
			fsAllow: [],
			clientEntries: ['/workspace/packages/workbench-app/src/client.tsx'],
			runnerPlugin: { name: 'runner-noop' },
			httpPlugin: { name: 'http-noop' },
		})

		expect(config.optimizeDeps).toMatchObject({
			entries: ['/workspace/packages/workbench-app/src/client.tsx'],
			needsInterop: ['react', 'react-dom'],
		})
		expect((config.optimizeDeps as { include?: string[] }).include).toEqual(
			expect.arrayContaining(['react', 'react-dom/client', '@tabler/icons-react']),
		)
		const ignored = config.server?.watch?.ignored as RegExp[]
		expect(ignored.some((pattern) => pattern.test('/workspace/native/target/debug'))).toBe(true)
		expect(ignored.some((pattern) => pattern.test('/workspace/.turbo/cache/task.json'))).toBe(true)

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
