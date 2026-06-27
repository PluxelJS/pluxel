import { getPluginInfo } from '../../decorators/PluginDecorator'
import type { ForkablePluginConstructor, PluginConstructor, PluginIdentifier } from '../../types'
import { forkPlugin, getForkedCtor } from '../fork'
import { runtimePluginKeyOfCtor, runtimePluginKeyOfName, type RuntimePluginKey } from '../identity'
import { formatForkPluginId, parseForkPluginId } from '../pluginId'

export type RuntimeModuleDeclarationItem = {
	ctor: PluginConstructor
	exportKey?: string
}

export type RuntimeModuleDeclaration = {
	moduleId: string
	items: readonly RuntimeModuleDeclarationItem[]
}

export type RuntimeModuleSnapshot =
	| {
			items: readonly RuntimeModuleDeclarationItem[]
			revision: number
	  }
	| undefined

export class RuntimeModuleRegistry {
	private readonly items = new Map<string, readonly RuntimeModuleDeclarationItem[]>()
	private readonly revisions = new Map<string, number>()
	private readonly moduleByName = new Map<string, string>()
	private readonly ctorByName = new Map<string, PluginConstructor>()
	private readonly moduleByCtor = new WeakMap<PluginConstructor, string>()
	private revision = 0

	public listItems(moduleId: string): readonly RuntimeModuleDeclarationItem[] {
		return this.items.get(moduleId) ?? []
	}

	public ctorForName(name: string): PluginConstructor | undefined {
		return this.ctorByName.get(name)
	}

	public getModuleId(
		id: PluginIdentifier | string,
		resolvedKey?: RuntimePluginKey,
	): string | undefined {
		if (typeof id === 'string') return this.getModuleIdByKey(id)
		if (resolvedKey) {
			const byResolved = this.getModuleIdByKey(resolvedKey)
			if (byResolved) return byResolved
		}
		if (typeof id === 'function') {
			const direct = this.moduleByCtor.get(id as PluginConstructor)
			if (direct) return direct
		}
		try {
			const info = getPluginInfo(id as PluginConstructor)
			return this.getModuleIdByKey(info.id)
		} catch {
			return undefined
		}
	}

	public resolveDependencyToken(token: PluginIdentifier): RuntimePluginKey | undefined {
		if (typeof token !== 'function') return undefined
		let id: string
		try {
			id = getPluginInfo(token as PluginConstructor).id
		} catch {
			return undefined
		}

		const exact = this.ctorByName.get(id)
		if (exact) return runtimePluginKeyOfCtor(exact)

		const fork = parseForkPluginId(id)
		if (fork) {
			const baseCtor = this.ctorByName.get(fork.baseId)
			if (!baseCtor) return runtimePluginKeyOfCtor(token)
			const existing = getForkedCtor(baseCtor, fork.forkId)
			if (existing) return runtimePluginKeyOfCtor(existing)
			try {
				forkPlugin(baseCtor as ForkablePluginConstructor, fork.forkId)
				return formatForkPluginId(fork.baseId, fork.forkId) as RuntimePluginKey
			} catch {
				return undefined
			}
		}

		return runtimePluginKeyOfName(id)
	}

	public upsert(module: RuntimeModuleDeclaration): void {
		this.set(module, ++this.revision)
	}

	public remove(moduleId: string): void {
		this.removeIndex(moduleId)
		this.items.delete(moduleId)
		this.revisions.delete(moduleId)
	}

	public snapshot(moduleId: string): RuntimeModuleSnapshot {
		const items = this.items.get(moduleId)
		if (!items) return undefined
		return {
			items: [...items],
			revision: this.revisions.get(moduleId) ?? 0,
		}
	}

	public restore(moduleId: string, snapshot: RuntimeModuleSnapshot): void {
		if (!snapshot) {
			this.remove(moduleId)
			return
		}
		this.set({ moduleId, items: snapshot.items }, snapshot.revision)
	}

	private getModuleIdByKey(key: string): string | undefined {
		const direct = this.moduleByName.get(key)
		if (direct) return direct
		const fork = parseForkPluginId(key)
		return fork ? this.moduleByName.get(fork.baseId) : undefined
	}

	private set(module: RuntimeModuleDeclaration, revision: number): void {
		const moduleId = module.moduleId
		this.removeIndex(moduleId)
		const items = cloneValidModuleItems(module.items)
		if (items.length === 0) {
			this.items.delete(moduleId)
			this.revisions.delete(moduleId)
			return
		}
		this.items.set(moduleId, items)
		this.revisions.set(moduleId, revision)
		if (revision > this.revision) this.revision = revision
		for (let i = 0; i < items.length; i++) {
			const { ctor } = items[i]!
			if (this.shouldClaimCtor(ctor, moduleId, revision)) {
				this.moduleByCtor.set(ctor, moduleId)
			}
			try {
				const info = getPluginInfo(ctor)
				if (this.shouldClaimName(info.id, moduleId, revision)) {
					this.moduleByName.set(info.id, moduleId)
					this.ctorByName.set(info.id, ctor)
				}
			} catch {
				// Keep ownership best-effort; invalid plugin ctors still fail at registration.
			}
		}
	}

	private shouldClaimName(name: string, moduleId: string, revision: number): boolean {
		const currentModuleId = this.moduleByName.get(name)
		if (!currentModuleId || currentModuleId === moduleId) return true
		return (this.revisions.get(currentModuleId) ?? 0) <= revision
	}

	private shouldClaimCtor(ctor: PluginConstructor, moduleId: string, revision: number): boolean {
		const currentModuleId = this.moduleByCtor.get(ctor)
		if (!currentModuleId || currentModuleId === moduleId) return true
		return (this.revisions.get(currentModuleId) ?? 0) <= revision
	}

	private removeIndex(moduleId: string): void {
		const prev = this.items.get(moduleId)
		if (!prev) return
		const prevCtors = new Set<PluginConstructor>()
		for (let i = 0; i < prev.length; i++) prevCtors.add(prev[i]!.ctor)

		const namesToRestore = new Set<string>()
		for (let i = 0; i < prev.length; i++) {
			const ctor = prev[i]!.ctor
			try {
				const info = getPluginInfo(ctor)
				if (this.moduleByName.get(info.id) !== moduleId) continue
				this.moduleByName.delete(info.id)
				const indexedCtor = this.ctorByName.get(info.id)
				if (indexedCtor && prevCtors.has(indexedCtor)) {
					this.ctorByName.delete(info.id)
				}
				namesToRestore.add(info.id)
			} catch {
				// Ignore invalid decorator state in stale declarations.
			}
		}

		const ctorsToRestore = new Set<PluginConstructor>()
		for (let i = 0; i < prev.length; i++) {
			const ctor = prev[i]!.ctor
			if (this.moduleByCtor.get(ctor) === moduleId) {
				this.moduleByCtor.delete(ctor)
				ctorsToRestore.add(ctor)
			}
		}

		for (const name of namesToRestore) this.restoreNameIndex(name, moduleId)
		for (const ctor of ctorsToRestore) this.restoreCtorIndex(ctor, moduleId)
	}

	private restoreNameIndex(name: string, skipModuleId: string): void {
		let best:
			| {
					moduleId: string
					ctor: PluginConstructor
					revision: number
			  }
			| undefined
		for (const [moduleId, items] of this.items) {
			if (moduleId === skipModuleId) continue
			const revision = this.revisions.get(moduleId) ?? 0
			for (let i = 0; i < items.length; i++) {
				const ctor = items[i]!.ctor
				try {
					if (getPluginInfo(ctor).id !== name) continue
					if (!best || revision >= best.revision) {
						best = { moduleId, ctor, revision }
					}
				} catch {
					// Ignore invalid decorator state in stale declarations.
				}
			}
		}
		if (!best) return
		this.moduleByName.set(name, best.moduleId)
		this.ctorByName.set(name, best.ctor)
	}

	private restoreCtorIndex(ctor: PluginConstructor, skipModuleId: string): void {
		let best:
			| {
					moduleId: string
					revision: number
			  }
			| undefined
		for (const [moduleId, items] of this.items) {
			if (moduleId === skipModuleId) continue
			const revision = this.revisions.get(moduleId) ?? 0
			for (let i = 0; i < items.length; i++) {
				if (items[i]!.ctor !== ctor) continue
				if (!best || revision >= best.revision) {
					best = { moduleId, revision }
				}
			}
		}
		if (best) this.moduleByCtor.set(ctor, best.moduleId)
	}
}

function cloneValidModuleItems(
	items: readonly RuntimeModuleDeclarationItem[],
): RuntimeModuleDeclarationItem[] {
	const next: RuntimeModuleDeclarationItem[] = []
	for (let i = 0; i < items.length; i++) {
		const item = items[i]!
		if (typeof item.ctor !== 'function') continue
		next.push({ ctor: item.ctor, exportKey: item.exportKey })
	}
	return next
}
