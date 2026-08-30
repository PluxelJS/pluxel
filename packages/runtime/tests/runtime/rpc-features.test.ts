import { createRuntimeHost } from '@pluxel/runtime/test'
import { describe, expect, it } from 'vitest'
import { RuntimeManagementTargetImpl } from '../../src/services/management/RuntimeManagementTarget'

function createRpcHost() {
	return createRuntimeHost()
}

describe('Runtime Management Agent tools capability', () => {
	it('reads and replaces the persisted policy through one scoped handle', async () => {
		const host = createRpcHost()
		try {
			const rpc = new RuntimeManagementTargetImpl(host.ctx)
			const initial = await rpc.agentToolsSnapshot()
			const saved = await rpc.replaceAgentToolsPolicy(initial.revision, {
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
