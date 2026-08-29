import { pluginNodeAddressOf } from '@pluxel/core'
import { BasePlugin, Plugin, withRuntimeHost } from '@pluxel/runtime/test'
import { workbench } from '@pluxel/runtime/workbench'
import { workbenchContract } from '@pluxel/runtime/workbench/contract'
import { describe, expect, it } from 'vitest'
import { requireWorkbench } from '../../src/services/workbench'
import { lowerTestPlugin } from '../helpers/lowered-plugin'

type TestRpc = {
	slow(): Promise<string>
	ping(): string
}

const contract = workbenchContract.define({
	resources: {
		commands: workbenchContract.rpc<TestRpc>(),
	},
	views: {
		Test: { placements: [workbenchContract.tab()] },
	},
})
const extension = workbench.extension({ contract })

describe('WorkbenchRpcService', () => {
	it('revokes future resolution without cancelling an entered RPC method', async () => {
		let entered!: () => void
		let release!: () => void
		const didEnter = new Promise<void>((resolve) => (entered = resolve))
		const gate = new Promise<void>((resolve) => (release = resolve))

		@Plugin({ displayName: 'RpcWorkbenchPlugin' })
		class RpcWorkbenchPlugin extends BasePlugin {
			override init(): void {
				this.ctx.workbench.mount(extension, {
					commands: workbench.bind.rpc(() => ({
						async slow() {
							entered()
							await gate
							return 'done'
						},
						ping: () => 'pong',
					})),
				})
			}
		}

		await withRuntimeHost(async (host) => {
			lowerTestPlugin(RpcWorkbenchPlugin)
			host.add(RpcWorkbenchPlugin)
			host.cfg(RpcWorkbenchPlugin).setAutoStart(true)
			host.start(RpcWorkbenchPlugin)
			await host.commit()
			const backend = requireWorkbench(host.ctx)
			const grantId = backend.registry.getPluginLayout(pluginNodeAddressOf(RpcWorkbenchPlugin))
				.items[0]!.model.commands!.grantId
			const resourceId = backend.registry.resolveModel(grantId, 'rpc').resourceId
			const rpc = backend.rpc.resolve(host.ctx, resourceId) as TestRpc
			const pending = rpc.slow()
			await didEnter

			host.remove(RpcWorkbenchPlugin)
			await host.commit()
			expect(backend.registry.findModel(grantId, 'rpc')).toBeNull()
			expect(() => backend.registry.resolveModel(grantId, 'rpc')).toThrow('invalid or expired')
			expect(() => backend.rpc.resolve(host.ctx, resourceId)).toThrow('unavailable')

			release()
			await expect(pending).resolves.toBe('done')
		})
	})
})
