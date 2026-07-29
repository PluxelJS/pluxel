// rpc/RuntimeRpcApi.ts - 主 RPC API
import type { Context } from '@pluxel/core'
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
	PackageManagerFeatureApi,
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

	packageManager(): PackageManagerFeatureApi | null {
		const factory =
			this.ctx.runtimeRoute?.packageManager ?? this.ctx.root.runtimeRoute?.packageManager
		return factory ? (factory(this.ctx) as PackageManagerFeatureApi) : null
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
		return workbench.rpc.resolve(
			this.ctx,
			`${ref.ownerPluginId}:${ref.modelKey}`,
		) as unknown as WorkbenchRpcView
	}

	async updatePluginGroups(groups: PluginGroupInput[]): Promise<PluginGroup[]> {
		const safe = Array.isArray(groups) ? groups : []
		return writeGroups(this.ctx, safe)
	}

	async pluginSchema(name: string) {
		return await pluginSchema(this.ctx, name)
	}

	async pluginConfig(name: string) {
		return await pluginConfigGet(this.ctx, name)
	}

	async patchPluginConfig(name: string, patch: Record<string, unknown>) {
		return await pluginConfigPatch(this.ctx, name, patch)
	}

	async patchPluginConfigField(name: string, input: ConfigFieldMutation) {
		return await pluginConfigPatchField(this.ctx, name, input)
	}

	pluginDependencies(name: string) {
		return listPluginDependencies(this.ctx, name)
	}

	inspectPluginDependencies(name: string) {
		return inspectPluginDependencies(this.ctx, name)
	}

	async setPluginDependencyTarget(input: {
		name: string
		index: number
		targetName: string | null
	}) {
		return await pluginDependencySetTarget(this.ctx, input.name, input.index, input.targetName)
	}

	inspectPluginBaseProvider(name: string) {
		return inspectPluginBaseProvider(this.ctx, name)
	}

	async selectPluginBaseProvider(input: {
		name: string
		baseToken: string
		providerName: string | null
	}) {
		return await pluginBaseProviderSet(this.ctx, input.name, input.baseToken, input.providerName)
	}

	async ensurePluginFork(input: { baseName: string; forkId: string; enable?: boolean }) {
		return await ensureFork(this.ctx, input.baseName, input.forkId, { enable: input.enable })
	}

	async applyPluginStatusActions(actions: PluginStatusBatchAction[]) {
		const safe = Array.isArray(actions) ? actions : []
		return await applyStatusActions(this.ctx, safe)
	}
}
