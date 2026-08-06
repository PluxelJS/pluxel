import { createRuntimeHost } from '@pluxel/runtime/test'
import { describe, expect, it } from 'vitest'
import { RuntimeRpcApi } from '../../src/api/http/rpc/RuntimeRpcApi'

function createRpcHost() {
	return createRuntimeHost()
}

describe('RuntimeRpcApi Agent tools capability', () => {
	it('reads and replaces the persisted policy through one scoped handle', async () => {
		const host = createRpcHost()
		try {
			const rpc = new RuntimeRpcApi(host.ctx)
			const initial = await rpc.agentTools().snapshot()
			const saved = await rpc.agentTools().replacePolicy(initial.revision, {
				toolsets: [{ id: 'runtime', label: 'Runtime', commandNames: ['plugin.list'] }],
				agents: [{ agentId: 'pi', label: 'Pi', toolsetIds: ['runtime'] }],
			})
			expect(saved.policy.agents[0]).toEqual({
				agentId: 'pi',
				label: 'Pi',
				toolsetIds: ['runtime'],
			})
		} finally {
			await host.dispose()
		}
	})
})
