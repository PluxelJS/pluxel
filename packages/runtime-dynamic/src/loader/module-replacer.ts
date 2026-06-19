import {
	type Context,
	checkPluginDecorator,
	getPluginInfo,
	type PluginConstructor,
} from '@pluxel/core'
import type { PluginRegistry } from './PluginRegistry'
import { type DepOverridesExtra, EXTRA_DEP_OVERRIDES } from './selection'
import type { AnchorJournal, AnchorStore } from './support'

type PluginRegistryTx = ReturnType<PluginRegistry['beginTransaction']>

type ReplaceModuleOptions = {
	tx?: PluginRegistryTx
	anchors?: AnchorJournal
}

export type ReplaceModuleResult = {
	isAnchor: boolean
	affectedModules: readonly string[]
}

type ExportedPlugin = {
	ctor: PluginConstructor
	exportKey: string
}

type AffectedModulesScratch = {
	marks: Uint8Array
	slots: number[]
	stack: number[]
}

export class ModuleReplacer {
	private readonly depOverrides: DependencyOverrideApplier
	private affectedScratch: AffectedModulesScratch = {
		marks: new Uint8Array(0),
		slots: [],
		stack: [],
	}

	constructor(
		private readonly ctx: Context,
		private readonly registry: PluginRegistry,
		private readonly anchors: AnchorStore,
		private readonly resolveRuntimeCtor: (name: string) => PluginConstructor | undefined,
	) {
		this.depOverrides = new DependencyOverrideApplier(this.ctx, this.resolveRuntimeCtor)
	}

	async replaceModule(
		moduleId: string,
		mod: Record<string, unknown>,
		options: ReplaceModuleOptions = {},
	): Promise<ReplaceModuleResult> {
		const id = moduleId
		options.anchors?.record(id)
		const oldItems = this.registry.modules.get(id) ?? []
		const exported = collectPluginExports(mod)
		const affectedModules = this.collectAffectedModules(oldItems)

		// 停旧模块本身；dependent declarations are kept and re-synced through affectedModules.
		// This preserves core graph identity/slots and lets lifecycle cascade happen at commit time.
		this.registry.stopModule(id, { cascadeDependents: false })

		// 清理旧声明，准备落新声明
		this.registry.undeclareModule(id, options.tx)

		for (const item of exported) {
			this.registry.declarePlugin(id, item.ctor, item.exportKey, options.tx)
		}
		const config = this.ctx.configService
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
		const isAnchor = exported.length > 0
		this.updateAnchors(id, isAnchor, options.anchors)

		return { isAnchor, affectedModules }
	}

	private collectAffectedModules(oldItems: readonly { ctor: PluginConstructor }[]): readonly string[] {
		if (oldItems.length === 0) return []
		const graph = this.ctx.registry.graph
		const slotCount = graph.slotCount()
		if (slotCount === 0) return []
		if (this.affectedScratch.marks.length < slotCount) {
			this.affectedScratch = {
				marks: new Uint8Array(slotCount),
				slots: [],
				stack: [],
			}
		}

		const { marks, slots, stack } = this.affectedScratch
		slots.length = 0
		stack.length = 0
		const out = new Set<string>()
		const pushRoot = (ctor: PluginConstructor) => {
			const key = graph.resolve(ctor)
			const slot = key === undefined ? undefined : graph.slotOf(key)
			if (slot === undefined || marks[slot] === 1) return
			marks[slot] = 1
			slots.push(slot)
			stack.push(slot)
		}
		for (const { ctor } of oldItems) {
			pushRoot(ctor)
			for (const forkCtor of this.ctx.registry.listForks(ctor)) {
				pushRoot(forkCtor as PluginConstructor)
			}
		}

		while (stack.length > 0) {
			const slot = stack.pop()!
			const name = graph.declarationAtSlot(slot)?.meta?.id
			if (name) {
				const moduleId = this.ctx.registry.getRuntimeModuleId(name) ?? this.registry.name2PathMap.get(name)
				if (moduleId) out.add(moduleId)
			}

			const dependents = graph.dependentSlotsOf(slot)
			for (let i = 0; i < dependents.length; i++) {
				const dep = dependents[i]!
				if (dep < 0 || dep >= marks.length || marks[dep] === 1) continue
				marks[dep] = 1
				slots.push(dep)
				stack.push(dep)
			}
		}

		for (let i = 0; i < slots.length; i++) marks[slots[i]!] = 0
		slots.length = 0
		stack.length = 0
		return [...out]
	}

	private updateAnchors(id: string, isAnchor: boolean, anchors?: AnchorJournal) {
		if (anchors) {
			anchors.update(id, isAnchor)
			return
		}
		if (isAnchor) this.anchors.add(id)
		else this.anchors.delete(id)
	}
}

function collectPluginExports(mod: Record<string, unknown>): ExportedPlugin[] {
	const exported: ExportedPlugin[] = []
	// Note: Vite runner may return an ESM namespace-like object where export keys are not enumerable.
	// Use getOwnPropertyNames to avoid missing plugin exports (would show as "plugins=0" in reports).
	for (const exportKey of Object.getOwnPropertyNames(mod)) {
		const exp = (mod as Record<string, unknown>)[exportKey]
		if (typeof exp !== 'function') continue
		if (!checkPluginDecorator(exp as any)) continue
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
	 * Publish persisted dependency selections (fork selection, etc.) as a core
	 * declaration overlay for the freshly declared runtime owner.
	 */
	async apply(ctor: PluginConstructor, registry: PluginRegistry) {
		const name = getPluginInfo(ctor).id
		const all = this.ctx.configService.getExtra<DepOverridesExtra>(EXTRA_DEP_OVERRIDES)
		const overrides = all?.[name]
		if (!overrides) {
			this.ctx.registry.setRuntimeDependencyOverrides(name, undefined)
			return
		}
		const consumerEnabled = this.ctx.configService.isEnabledInConfig(name)
		const next: Array<PluginConstructor | undefined> = []

		for (const [rawIndex, targetName] of Object.entries(overrides)) {
			const index = Number(rawIndex)
			if (!Number.isFinite(index) || index < 0) continue

			if (typeof targetName !== 'string' || targetName.trim() === '') continue

			const normalized = targetName.trim()
			const token = this.resolveRuntimeCtor(normalized)
			if (!token) continue
			next[index] = token

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
		this.ctx.registry.setRuntimeDependencyOverrides(
			name,
			next.length === 0 ? undefined : next,
		)
	}
}
