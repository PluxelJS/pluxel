import {
	BasePlugin,
	type Context,
	checkPluginDecorator,
	clearParamToken,
	getClassParams,
	getPluginInfo,
	type PluginConstructor,
	setParamToken,
	setParamTokens,
} from '@pluxel/core'
import type { PluginRegistry } from './PluginRegistry'
import { type DepOverridesExtra, EXTRA_DEP_OVERRIDES } from './selection'
import type { AnchorJournal } from './support'

type PluginRegistryTx = ReturnType<PluginRegistry['beginTransaction']>

type ReplaceModuleOptions = {
	tx?: PluginRegistryTx
	anchors?: AnchorJournal
}

type ExportedPlugin = {
	ctor: PluginConstructor
	exportKey: string
}

export class ModuleReplacer {
	private readonly depOverrides: DependencyOverrideApplier

	constructor(
		private readonly ctx: Context,
		private readonly registry: PluginRegistry,
		private readonly anchors: Set<string>,
		resolveRuntimeCtor: (name: string) => PluginConstructor | undefined,
		private readonly normalizeModuleId: (moduleId: string) => string,
	) {
		this.depOverrides = new DependencyOverrideApplier(this.ctx, resolveRuntimeCtor)
	}

	async replaceModule(
		moduleId: string,
		mod: Record<string, unknown>,
		options: ReplaceModuleOptions = {},
	): Promise<boolean> {
		const id = options.tx ? moduleId : this.normalizeModuleId(moduleId)
		options.anchors?.record(id)
		const oldItems = this.registry.modules.get(id) ?? []
		// 停旧（只影响运行层，保留声明关系以便冲突判断更清晰）
		this.registry.stopModule(id)

		// 清理旧声明，准备落新声明
		this.registry.undeclareModule(id, options.tx)

		const exported = collectPluginExports(mod)
		for (const item of exported) {
			this.registry.declarePlugin(id, item.ctor, item.exportKey, options.tx)
		}

		const config = getConfigReady(this.ctx)
		const startEnabled = async () => {
			// Apply persisted dependency overrides after all exports are declared.
			for (const item of exported) await this.depOverrides.apply(item.ctor, this.registry)
			// 运行层：根据持久启用位，自动启用需要启用的插件
			await this.registry.syncRuntimeForModule(id)
		}

		// Do not block startup if config is still loading.
		if (config.isReady) {
			await startEnabled()
		} else {
			void config.ready.then(startEnabled).catch((error) => {
				this.ctx.logger.warn('config ready failed; auto-start aborted for this module', {
					moduleId: id,
					error,
				})
			})
		}
		this.refreshDependents(oldItems)

		const isAnchor = exported.length > 0
		this.updateAnchors(id, isAnchor, options.anchors)

		return isAnchor
	}

	private updateAnchors(id: string, isAnchor: boolean, anchors?: AnchorJournal) {
		if (anchors) {
			anchors.update(id, isAnchor)
			return
		}
		if (isAnchor) this.anchors.add(id)
		else this.anchors.delete(id)
	}

	/**
	 * 热更后，用当前 name -> ctor 映射重绑依赖者的构造参数引用，避免旧引用导致 MissingDependency。
	 * 只处理受影响插件的直接依赖者，开销低。
	 */
	private refreshDependents(oldItems: readonly { ctor: PluginConstructor }[]) {
		if (oldItems.length === 0) return
		const dependents = this.ctx.registry.container?.dependents
		if (!dependents?.size) return
		const dependentsMap = dependents as unknown as Map<unknown, Set<unknown>>

		const affected = new Set<PluginConstructor>()
		for (const { ctor } of oldItems) {
			const deps = dependentsMap.get(ctor)
			if (!deps) continue
			for (const dep of deps) {
				if (typeof dep === 'function') affected.add(dep as PluginConstructor)
			}
		}
		if (affected.size === 0) return

		const nameMap = this.registry.names
		for (const depCtor of affected) {
			const params = getClassParams(depCtor)
			const next = params.slice()
			let mutated = false
			for (let i = 0; i < next.length; i++) {
				const p = next[i]
				if (typeof p !== 'function') continue
				const proto = (p as { prototype?: unknown }).prototype
				if (!proto || !(proto instanceof BasePlugin)) continue
				let pid: string
				try {
					pid = getPluginInfo(p as PluginConstructor).id
				} catch {
					continue
				}
				const current = nameMap.get(pid)
				if (current && current !== p) {
					next[i] = current
					mutated = true
				}
			}
			if (mutated) {
				setParamTokens(depCtor, next as unknown as Parameters<typeof setParamTokens>[1])
			}
		}
	}
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
	if (!value) return false
	if (typeof value !== 'object' && typeof value !== 'function') return false
	const record = value as Record<string, unknown>
	return typeof record.then === 'function'
}

function getConfigReady(ctx: Context): { isReady: boolean; ready: Promise<void> } {
	const svc = ctx.configService as unknown
	if (!svc || typeof svc !== 'object') return { isReady: true, ready: Promise.resolve() }
	const record = svc as Record<string, unknown>
	const ready = record.ready
	const isReady = record.isReady === true
	if (!isPromiseLike(ready)) return { isReady: true, ready: Promise.resolve() }
	return { isReady, ready: ready as Promise<void> }
}

function collectPluginExports(mod: Record<string, unknown>): ExportedPlugin[] {
	const exported: ExportedPlugin[] = []
	for (const [exportKey, exp] of Object.entries(mod)) {
		if (typeof exp !== 'function') continue
		if (!checkPluginDecorator(exp)) continue
		exported.push({ ctor: exp as PluginConstructor, exportKey })
	}
	return exported
}

class DependencyOverrideApplier {
	constructor(
		private readonly ctx: Context,
		private readonly resolveRuntimeCtor: (name: string) => PluginConstructor | undefined,
	) {}

	/**
	 * Apply persisted constructor parameter token overrides (fork selection, etc.)
	 * onto a freshly declared ctor (important across HMR reloads).
	 */
	async apply(ctor: PluginConstructor, registry: PluginRegistry) {
		const configService = this.ctx.configService as unknown
		if (!configService || typeof configService !== 'object') return
		const getExtra = (configService as { getExtra?: unknown }).getExtra
		if (typeof getExtra !== 'function') return

		const name = getPluginInfo(ctor).id
		const all = getExtra.call(this.ctx.configService, EXTRA_DEP_OVERRIDES) as
			| DepOverridesExtra
			| undefined
		const overrides = all?.[name]
		if (!overrides) return
		const consumerEnabled = this.ctx.configService.isEnabledInConfig(name)

		for (const [rawIndex, targetName] of Object.entries(overrides)) {
			const index = Number(rawIndex)
			if (!Number.isFinite(index) || index < 0) continue

			if (typeof targetName !== 'string' || targetName.trim() === '') {
				clearParamToken(ctor, index)
				continue
			}

			const normalized = targetName.trim()
			const token = this.resolveRuntimeCtor(normalized)
			if (!token) continue
			setParamToken(ctor, index, token as unknown as Parameters<typeof setParamToken>[2])

			// If the consumer is enabled, the selected dependency must be enabled/registered too;
			// otherwise DI build will fail on the next commit (common for persisted fork selections).
			if (consumerEnabled) {
				try {
					await registry.enable(normalized, token)
				} catch (error) {
					this.ctx.logger.warn('依赖注入目标启用失败：{target}（可能导致 commit 失败）', {
						target: normalized,
						consumer: name,
						error,
					})
				}
			}
		}
	}
}
