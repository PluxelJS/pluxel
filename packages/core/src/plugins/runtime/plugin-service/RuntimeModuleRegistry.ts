import { getPluginDefinitionFacts } from '../definition'
import type { PluginConstructor } from '../../types'
import type { PluginDefinitionSlot, PluginNodeSlot, PluginSlotRegistry } from '../identity'

export type RuntimeModuleDeclarationItem = { readonly ctor: PluginConstructor }

export type RuntimeModuleDeclaration = {
	readonly moduleId: string
	readonly items: readonly RuntimeModuleDeclarationItem[]
}

export type RuntimeModuleSnapshot =
	| { readonly items: readonly RuntimeModuleDeclarationItem[]; readonly revision: number }
	| undefined

export class RuntimeModuleRegistry {
	private readonly items = new Map<string, readonly RuntimeModuleDeclarationItem[]>()
	private readonly revisions = new Map<string, number>()
	private readonly moduleByDefinition = new Map<PluginDefinitionSlot, string>()
	private readonly ctorByDefinition = new Map<PluginDefinitionSlot, PluginConstructor>()
	private readonly moduleByCtor = new WeakMap<PluginConstructor, string>()
	private revision = 0

	constructor(private readonly slots: PluginSlotRegistry) {}

	listItems(moduleId: string): readonly RuntimeModuleDeclarationItem[] {
		return this.items.get(moduleId) ?? []
	}

	ctorForDefinition(definition: PluginDefinitionSlot): PluginConstructor | undefined {
		return this.ctorByDefinition.get(definition)
	}

	getModuleId(slot: PluginDefinitionSlot | PluginNodeSlot): string | undefined {
		const definition = 'definition' in slot ? slot.definition : slot
		return this.moduleByDefinition.get(definition)
	}

	getModuleIdForConstructor(ctor: PluginConstructor): string | undefined {
		return this.moduleByCtor.get(ctor)
	}

	upsert(module: RuntimeModuleDeclaration): void {
		this.set(module, ++this.revision)
	}

	remove(moduleId: string): void {
		this.removeIndex(moduleId)
		this.items.delete(moduleId)
		this.revisions.delete(moduleId)
	}

	snapshot(moduleId: string): RuntimeModuleSnapshot {
		const items = this.items.get(moduleId)
		return items ? { items: [...items], revision: this.revisions.get(moduleId) ?? 0 } : undefined
	}

	restore(moduleId: string, snapshot: RuntimeModuleSnapshot): void {
		if (!snapshot) return this.remove(moduleId)
		this.set({ moduleId, items: snapshot.items }, snapshot.revision)
	}

	private set(module: RuntimeModuleDeclaration, revision: number): void {
		this.removeIndex(module.moduleId)
		const items = module.items
			.filter((item) => typeof item.ctor === 'function')
			.map((item) => ({ ctor: item.ctor }))
		if (items.length === 0) return
		this.items.set(module.moduleId, items)
		this.revisions.set(module.moduleId, revision)
		this.revision = Math.max(this.revision, revision)
		for (const { ctor } of items) {
			const facts = getPluginDefinitionFacts(ctor)
			if (facts.kind !== 'plugin')
				throw new Error('[pluxel/core] Runtime module item must be a concrete Plugin')
			const definition = this.slots.internDefinition(facts.definition)
			if (this.shouldClaim(definition, module.moduleId, revision)) {
				this.moduleByDefinition.set(definition, module.moduleId)
				this.ctorByDefinition.set(definition, ctor)
			}
			this.moduleByCtor.set(ctor, module.moduleId)
		}
	}

	private shouldClaim(
		definition: PluginDefinitionSlot,
		moduleId: string,
		revision: number,
	): boolean {
		const current = this.moduleByDefinition.get(definition)
		return !current || current === moduleId || (this.revisions.get(current) ?? 0) <= revision
	}

	private removeIndex(moduleId: string): void {
		const previous = this.items.get(moduleId)
		if (!previous) return
		const removedDefinitions = new Set<PluginDefinitionSlot>()
		for (const { ctor } of previous) {
			const facts = getPluginDefinitionFacts(ctor)
			const definition = this.slots.internDefinition(facts.definition)
			if (this.moduleByDefinition.get(definition) === moduleId) {
				this.moduleByDefinition.delete(definition)
				this.ctorByDefinition.delete(definition)
				removedDefinitions.add(definition)
			}
			if (this.moduleByCtor.get(ctor) === moduleId) this.moduleByCtor.delete(ctor)
		}
		for (const definition of removedDefinitions) this.restoreDefinition(definition, moduleId)
	}

	private restoreDefinition(definition: PluginDefinitionSlot, skip: string): void {
		let best: { moduleId: string; ctor: PluginConstructor; revision: number } | undefined
		for (const [moduleId, items] of this.items) {
			if (moduleId === skip) continue
			const revision = this.revisions.get(moduleId) ?? 0
			for (const { ctor } of items) {
				const facts = getPluginDefinitionFacts(ctor)
				if (this.slots.internDefinition(facts.definition) !== definition) continue
				if (!best || revision >= best.revision) best = { moduleId, ctor, revision }
			}
		}
		if (!best) return
		this.moduleByDefinition.set(definition, best.moduleId)
		this.ctorByDefinition.set(definition, best.ctor)
	}
}
