import { createHost } from '@pluxel/test'
import { describe, expect, it } from 'vitest'
import { getRuntimeApiResolvers } from '../../src/api/contributions'
import { RuntimeRpcApi } from '../../src/api/http/rpc/RuntimeRpcApi'

function createRpcHost() {
	const host = createHost()
	Object.defineProperty(host.ctx, 'ext', {
		value: {
			rpc: {
				createExtensionsView: () => ({}),
				getNamespaces: () => [],
			},
		},
		configurable: true,
	})
	return host
}

describe('RuntimeRpcApi route features', () => {
	it('discovers and resolves route feature handles without fixed package methods', async () => {
		const host = createRpcHost()
		const handle = { ok: true }
		host.ctx.runtimeRoute = {
			catalog: {} as never,
			features: {
				packageManager: () => handle,
			},
		}

		try {
			const rpc = new RuntimeRpcApi(host.ctx)
			expect('package' in rpc).toBe(false)
			expect(rpc.features()).toEqual(['packageManager'])
			expect(rpc.feature('packageManager')).toBe(handle)
		} finally {
			await host.dispose()
		}
	})

	it('fails route feature lookup when the current route does not provide it', async () => {
		const host = createRpcHost()
		host.ctx.runtimeRoute = { catalog: {} as never }

		try {
			const rpc = new RuntimeRpcApi(host.ctx)
			expect(rpc.features()).toEqual([])
			expect(() => rpc.feature('packageManager')).toThrow(
				'route feature "packageManager" is not available',
			)
		} finally {
			await host.dispose()
		}
	})

	it('keeps route API contributions optional for build-time clients', () => {
		expect(getRuntimeApiResolvers({} as never)).toEqual([])
	})
})
