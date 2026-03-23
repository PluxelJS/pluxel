import type { ExtensionModuleState } from '@pluxel/runtime/web/extensions'

function isEqualState(
	left: ExtensionModuleState | undefined,
	right: ExtensionModuleState | undefined,
): boolean {
	if (left === right) return true
	if (!left || !right) return false
	return (
		left.pluginName === right.pluginName &&
		left.state === right.state &&
		left.updatedAt === right.updatedAt &&
		left.sourceHash === right.sourceHash &&
		left.compiledAt === right.compiledAt &&
		left.message === right.message
	)
}

class ExtensionModuleStateStore {
	private readonly states = new Map<string, ExtensionModuleState>()
	private readonly listeners = new Set<() => void>()
	private readonly pluginListeners = new Map<string, Set<() => void>>()
	private allSnapshot: ExtensionModuleState[] | null = null

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
	}

	subscribePlugin(pluginName: string, listener: () => void): () => void {
		let bucket = this.pluginListeners.get(pluginName)
		if (!bucket) {
			bucket = new Set()
			this.pluginListeners.set(pluginName, bucket)
		}
		bucket.add(listener)
		return () => {
			const current = this.pluginListeners.get(pluginName)
			if (!current) return
			current.delete(listener)
			if (current.size === 0) {
				this.pluginListeners.delete(pluginName)
			}
		}
	}

	get(pluginName: string): ExtensionModuleState | undefined {
		return this.states.get(pluginName)
	}

	getAll(): ExtensionModuleState[] {
		if (this.allSnapshot) return this.allSnapshot
		this.allSnapshot = Array.from(this.states.values()).sort((a, b) =>
			a.pluginName.localeCompare(b.pluginName),
		)
		return this.allSnapshot
	}

	upsert(state: ExtensionModuleState): boolean {
		const previous = this.states.get(state.pluginName)
		if (isEqualState(previous, state)) return false
		this.states.set(state.pluginName, state)
		this.notify(new Set([state.pluginName]))
		return true
	}

	remove(pluginName: string): boolean {
		if (!this.states.delete(pluginName)) return false
		this.notify(new Set([pluginName]))
		return true
	}

	replaceAll(nextStates?: ExtensionModuleState[]): boolean {
		const nextMap = new Map<string, ExtensionModuleState>()
		for (const state of nextStates ?? []) {
			if (!state?.pluginName) continue
			nextMap.set(state.pluginName, state)
		}

		const touched = new Set<string>()

		for (const pluginName of this.states.keys()) {
			const next = nextMap.get(pluginName)
			if (next) continue
			this.states.delete(pluginName)
			touched.add(pluginName)
		}

		for (const [pluginName, next] of nextMap.entries()) {
			const current = this.states.get(pluginName)
			if (isEqualState(current, next)) continue
			this.states.set(pluginName, next)
			touched.add(pluginName)
		}

		if (touched.size === 0) return false
		this.notify(touched)
		return true
	}

	clear(): boolean {
		if (this.states.size === 0) return false
		const touched = new Set(this.states.keys())
		this.states.clear()
		this.notify(touched)
		return true
	}

	private notify(pluginNames: Set<string>): void {
		this.allSnapshot = null
		for (const listener of this.listeners) {
			try {
				listener()
			} catch {
				// ignore subscriber errors
			}
		}
		for (const pluginName of pluginNames) {
			const bucket = this.pluginListeners.get(pluginName)
			if (!bucket) continue
			for (const listener of bucket) {
				try {
					listener()
				} catch {
					// ignore subscriber errors
				}
			}
		}
	}
}

const extensionModuleStateStore = new ExtensionModuleStateStore()

let manifestSyncHandler: ((force?: boolean) => void | Promise<void>) | null = null

export function subscribeExtensionModuleStates(listener: () => void): () => void {
	return extensionModuleStateStore.subscribe(listener)
}

export function subscribePluginExtensionModuleState(
	pluginName: string,
	listener: () => void,
): () => void {
	return extensionModuleStateStore.subscribePlugin(pluginName, listener)
}

export function getExtensionModuleState(pluginName: string): ExtensionModuleState | undefined {
	return extensionModuleStateStore.get(pluginName)
}

export function getExtensionModuleStates(): ExtensionModuleState[] {
	return extensionModuleStateStore.getAll()
}

export function upsertExtensionModuleState(state: ExtensionModuleState): boolean {
	return extensionModuleStateStore.upsert(state)
}

export function removeExtensionModuleState(pluginName: string): boolean {
	return extensionModuleStateStore.remove(pluginName)
}

export function replaceExtensionModuleStates(states?: ExtensionModuleState[]): boolean {
	return extensionModuleStateStore.replaceAll(states)
}

export function clearExtensionModuleStates(): boolean {
	return extensionModuleStateStore.clear()
}

export function setExtensionManifestSyncHandler(
	handler: ((force?: boolean) => void | Promise<void>) | null,
): void {
	manifestSyncHandler = handler
}

export function requestExtensionManifestSync(force = true): void {
	if (!manifestSyncHandler) return
	void manifestSyncHandler(force)
}
