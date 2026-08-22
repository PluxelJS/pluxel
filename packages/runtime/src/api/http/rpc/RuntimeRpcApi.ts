// rpc/RuntimeRpcApi.ts - 主 RPC API
import { parsePluginNodeAddress, type Context, type PluginNodeAddress } from '@pluxel/core'
import { RpcTarget } from 'capnweb'
import { writeGroups } from '../../features/pluginGroups/service'
import {
	pluginConfigGet,
	pluginConfigPatch,
	pluginConfigPatchField,
	pluginSchema,
} from '../../usecases/pluginConfig'
import {
	inspectPluginBaseProvider,
	inspectPluginDependencies,
	listPluginDependencies,
	pluginBaseProviderSet,
	pluginDependencySetTarget,
} from '../../usecases/pluginDependencies'
import { ensureFork } from '../../usecases/pluginForks'
import { applyStatusActions } from '../../usecases/pluginStatus'
import { LoggingHandle } from './LoggingHandle'
import { AgentToolsHandle } from './AgentToolsHandle'
import { requireWorkbench } from '../../../services/workbench'
import type {
	ConfigFieldMutation,
	WorkbenchRpcView,
	PluginGroup,
	PluginGroupInput,
	PluginStatusBatchAction,
} from '../../../web/protocol'

export class RuntimeRpcApi extends RpcTarget {
	private readonly ctx: Context

	constructor(ctx: Context) {
		super()
		this.ctx = ctx
	}

	ping() {
		return 'runtime-rpc:ok'
	}

	/** Logging settings (host-level, persisted). */
	logging() {
		return new LoggingHandle(this.ctx)
	}

	/** Persisted Agent toolsets and assignments over the live command catalog. */
	agentTools() {
		return new AgentToolsHandle(this.ctx)
	}

	workbenchRpc(grantId: string): WorkbenchRpcView {
		const workbench = requireWorkbench(this.ctx)
		const ref = workbench.registry.resolveModel(grantId, 'rpc')
		return workbench.rpc.resolve(this.ctx, ref.resourceId) as unknown as WorkbenchRpcView
	}

	async updatePluginGroups(groups: PluginGroupInput[]): Promise<PluginGroup[]> {
		const safe = Array.isArray(groups) ? groups : []
		const output = await writeGroups(this.ctx, safe)
		return output.map((group) =>
			Object.assign({}, group, {
				nodes: group.nodes.map((node) => ({
					...node,
					address: parsePluginNodeAddress(node.address),
				})),
			}),
		)
	}

	async pluginSchema(owner: PluginNodeAddress) {
		return await pluginSchema(this.ctx, owner)
	}

	async pluginConfig(owner: PluginNodeAddress) {
		return await pluginConfigGet(this.ctx, owner)
	}

	async patchPluginConfig(owner: PluginNodeAddress, patch: Record<string, unknown>) {
		return await pluginConfigPatch(this.ctx, owner, patch)
	}

	async patchPluginConfigField(owner: PluginNodeAddress, input: ConfigFieldMutation) {
		return await pluginConfigPatchField(this.ctx, owner, input)
	}

	pluginDependencies(owner: PluginNodeAddress) {
		return listPluginDependencies(this.ctx, owner)
	}

	inspectPluginDependencies(owner: PluginNodeAddress) {
		return inspectPluginDependencies(this.ctx, owner)
	}

	async setPluginDependencyTarget(input: {
		consumer: PluginNodeAddress
		index: number
		provider: PluginNodeAddress | null
	}) {
		return await pluginDependencySetTarget(this.ctx, input.consumer, input.index, input.provider)
	}

	inspectPluginBaseProvider(owner: PluginNodeAddress) {
		return inspectPluginBaseProvider(this.ctx, owner)
	}

	async selectPluginBaseProvider(input: {
		consumer: PluginNodeAddress
		token: import('@pluxel/core').PluginDefinitionAddress
		provider: PluginNodeAddress | null
	}) {
		return await pluginBaseProviderSet(this.ctx, input.consumer, input.token, input.provider)
	}

	async ensurePluginFork(input: { base: PluginNodeAddress; forkId: string; enable?: boolean }) {
		return await ensureFork(this.ctx, input.base, input.forkId, { enable: input.enable })
	}

	async applyPluginStatusActions(actions: PluginStatusBatchAction[]) {
		const safe = Array.isArray(actions) ? actions : []
		return await applyStatusActions(this.ctx, safe)
	}
}
