import { createRuntimeHost } from '@pluxel/runtime/test'
import { describe, expect, it } from 'vitest'
import { RuntimeRpcApi } from '../../src/api/http/rpc/RuntimeRpcApi'

function createRpcHost() {
	return createRuntimeHost()
}

describe('RuntimeRpcApi package manager capability', () => {
	it('resolves the exact route capability', async () => {
		const host = createRpcHost()
		const handle = { ok: true }
		host.ctx.runtimeRoute = {
			catalog: {} as never,
			packageManager: () => handle,
		}

		try {
			const rpc = new RuntimeRpcApi(host.ctx)
			expect(rpc.packageManager()).toBe(handle)
		} finally {
			await host.dispose()
		}
	})

	it('returns null when the current route does not provide it', async () => {
		const host = createRpcHost()
		host.ctx.runtimeRoute = { catalog: {} as never }

		try {
			const rpc = new RuntimeRpcApi(host.ctx)
			expect(rpc.packageManager()).toBeNull()
		} finally {
			await host.dispose()
		}
	})
})
