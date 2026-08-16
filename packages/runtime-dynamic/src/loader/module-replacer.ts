import {
	checkPluginDecorator,
	isPluginNodeSlot,
	pluginNodeAddressOf,
	type Context,
	type PluginConstructor,
	type PluginNodeSlot,
} from '@pluxel/core'
import type { ModuleItem, PluginRegistry, PluginRegistryTransaction } from './PluginRegistry'
import type { AnchorJournal, AnchorStore } from './support'

type ReplaceModuleOptions = {
	tx?: PluginRegistryTransaction
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
	private affectedScratch: AffectedModulesScratch = {
		marks: new Uint8Array(0),
		slots: [],
		stack: [],
	}

	constructor(
		private readonly ctx: Context,
		private readonly registry: PluginRegistry,
		private readonly anchors: AnchorStore,
	) {}

	async replaceModule(
		moduleId: string,
		mod: Record<string, unknown>,
		options: ReplaceModuleOptions = {},
	): Promise<ReplaceModuleResult> {
		options.anchors?.record(moduleId)
		const exported = collectPluginExports(mod)
		const { affectedModules } = this.removeModule(moduleId, options)

		for (const item of exported) {
			// Declaration validation is intentionally inside the loader transaction. Missing/corrupt
			// lowering facts and root-export mismatches fail the whole source update.
			this.registry.declarePlugin(moduleId, item.ctor, item.exportKey, options.tx)
		}

		if (!this.ctx.configService.isReady) await this.ctx.configService.ready
		await this.registry.syncRuntimeForModule(moduleId, { tx: options.tx })
		const isAnchor = exported.length > 0
		this.updateAnchors(moduleId, isAnchor, options.anchors)
		return { isAnchor, affectedModules }
	}

	removeModule(moduleId: string, options: ReplaceModuleOptions = {}): ReplaceModuleResult {
		options.anchors?.record(moduleId)
		const oldItems = this.registry.listModuleItems(moduleId)
		const affectedModules = this.collectAffectedModules(oldItems)

		// Preserve dependent declarations. Core sees removal/re-registration at the same node slot and
		// owns the unioned required+optional stop/restart closure during commit.
		this.registry.stopModule(moduleId, {
			cascadeDependents: false,
			tx: options.tx,
		})
		this.registry.undeclareModule(moduleId, options.tx)
		this.updateAnchors(moduleId, false, options.anchors)
		return { isAnchor: false, affectedModules }
	}

	private collectAffectedModules(oldItems: readonly ModuleItem[]): readonly string[] {
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
		const modules = new Set<string>()
		const pushRoot = (node: PluginNodeSlot) => {
			const slot = graph.slotOf(node)
			if (slot === undefined || marks[slot] === 1) return
			marks[slot] = 1
			slots.push(slot)
			stack.push(slot)
		}

		for (const item of oldItems) {
			pushRoot(item.nodeSlot)
			for (const forkCtor of this.ctx.registry.listForks(item.ctor)) {
				pushRoot(this.ctx.registry.internNodeAddress(pluginNodeAddressOf(forkCtor)))
			}
		}

		while (stack.length > 0) {
			const slot = stack.pop()!
			const node = graph.keyOf(slot)
			if (isPluginNodeSlot(node)) {
				const moduleId = this.registry.findModuleIdByNodeSlot(node)
				if (moduleId) modules.add(moduleId)
			}
			for (const dependent of graph.orderDependentSlotsOf(slot)) {
				if (dependent < 0 || dependent >= marks.length || marks[dependent] === 1) continue
				marks[dependent] = 1
				slots.push(dependent)
				stack.push(dependent)
			}
		}

		for (const slot of slots) marks[slot] = 0
		slots.length = 0
		stack.length = 0
		return [...modules].sort()
	}

	private updateAnchors(id: string, isAnchor: boolean, anchors?: AnchorJournal): void {
		if (anchors) anchors.update(id, isAnchor)
		else if (isAnchor) this.anchors.add(id)
		else this.anchors.delete(id)
	}
}

function collectPluginExports(mod: Record<string, unknown>): ExportedPlugin[] {
	const exported: ExportedPlugin[] = []
	for (const exportKey of Object.getOwnPropertyNames(mod)) {
		const value = mod[exportKey]
		if (typeof value !== 'function' || !checkPluginDecorator(value)) continue
		exported.push({ ctor: value as PluginConstructor, exportKey })
	}
	return exported
}
