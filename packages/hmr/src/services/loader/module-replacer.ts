import {
	BasePlugin,
	checkPluginDecorator,
	clearParamToken,
	getClassParams,
	getPluginInfo,
	setParamToken,
	setParamTokens,
	type Context,
	type PluginConstructor,
} from '@pluxel/core'
import type { PluginRegistry } from './PluginRegistry'
import type { AnchorJournal } from './support'
import { EXTRA_DEP_OVERRIDES, type DepOverridesExtra } from './selection'

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

		// Apply persisted dependency overrides after all exports are declared
		for (const item of exported) this.depOverrides.apply(item.ctor)

		// 运行层：根据持久启用位，自动启用需要启用的插件
		await this.registry.syncRuntimeForModule(id)
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
		const dependentsMap = this.ctx.registry.container?.dependents
		if (!dependentsMap?.size) return

		const affected = new Set<PluginConstructor>()
		for (const { ctor } of oldItems) {
			const deps = dependentsMap.get(ctor as any)
			if (!deps) continue
			for (const dep of deps) affected.add(dep as PluginConstructor)
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
				if (!((p as any)?.prototype instanceof BasePlugin)) continue
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
			if (mutated) setParamTokens(depCtor, next as any)
		}
	}
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
	apply(ctor: PluginConstructor) {
		const getExtra = (this.ctx.configService as any)?.getExtra as
			| ((key: string) => unknown)
			| undefined
		if (typeof getExtra !== 'function') return

		const name = getPluginInfo(ctor).id
		const all = getExtra.call(this.ctx.configService, EXTRA_DEP_OVERRIDES) as
			| DepOverridesExtra
			| undefined
		const overrides = all?.[name]
		if (!overrides) return

		for (const [rawIndex, targetName] of Object.entries(overrides)) {
			const index = Number(rawIndex)
			if (!Number.isFinite(index) || index < 0) continue

			if (typeof targetName !== 'string' || targetName.trim() === '') {
				clearParamToken(ctor, index)
				continue
			}

			const token = this.resolveRuntimeCtor(targetName)
			if (!token) continue
			setParamToken(ctor, index, token as any)
		}
	}
}
