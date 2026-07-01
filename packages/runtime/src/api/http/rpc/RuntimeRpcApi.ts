// rpc/RuntimeRpcApi.ts - 主 RPC API
import type { Context } from '@pluxel/core'
import { RpcTarget } from 'capnweb'
import { writeGroups } from '../../features/pluginGroups/service'
import { createRuntimeRouteFeatureHandle, listRuntimeRouteFeatures } from '../../contributions'
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
import { ExtensionSessionHandle } from './ExtensionSessionHandle'
import { LoggingHandle } from './LoggingHandle'
import type {
	ConfigFieldMutation,
	ExtensionUiRpcMap,
	PluginGroup,
	PluginGroupInput,
	PluginStatusBatchAction,
	RuntimeRouteFeatureApi,
	RuntimeRouteFeatureName,
} from '../../../web/protocol'

export class RuntimeRpcApi extends RpcTarget {
	private readonly ctx: Context
	private readonly extView: ExtensionUiRpcMap

	constructor(ctx: Context) {
		super()
		this.ctx = ctx
		this.extView = ctx.ext.rpc.createExtensionsView(ctx)
	}

	ping() {
		return 'runtime-rpc:ok'
	}

	/** Route-provided optional control-plane features. */
	features(): string[] {
		return listRuntimeRouteFeatures(this.ctx)
	}

	/** Lookup a route feature handle after checking `features()`. */
	feature<Name extends RuntimeRouteFeatureName>(name: Name): RuntimeRouteFeatureApi<Name> {
		return createRuntimeRouteFeatureHandle<RuntimeRouteFeatureApi<Name>>(this.ctx, name)
	}

	/** Logging settings (host-level, persisted). */
	logging() {
		return new LoggingHandle(this.ctx)
	}

	/** Cross-plugin interaction sessions (surface/offer lifecycle). */
	ui() {
		return new ExtensionSessionHandle(this.ctx)
	}

	/**
	 * 访问插件注册的 RPC 扩展
	 * @example rpc.ext['my-plugin'].method()
	 */
	get ext(): ExtensionUiRpcMap {
		return this.extView
	}

	/**
	 * 列出所有已注册的 RPC 扩展命名空间
	 */
	extensions(): string[] {
		return this.ctx.ext.rpc.getNamespaces()
	}

	async buildSnapshot() {
		return {
			ok: false as const,
			error: 'Snapshot builder is temporarily unavailable while the plugin is being rewritten.',
		}
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
		return await pluginBaseProviderSet(
			this.ctx,
			input.name,
			input.baseToken,
			input.providerName,
		)
	}

	async ensurePluginFork(input: { baseName: string; forkId: string; enable?: boolean }) {
		return await ensureFork(this.ctx, input.baseName, input.forkId, { enable: input.enable })
	}

	async applyPluginStatusActions(actions: PluginStatusBatchAction[]) {
		const safe = Array.isArray(actions) ? actions : []
		return await applyStatusActions(this.ctx, safe)
	}
}
