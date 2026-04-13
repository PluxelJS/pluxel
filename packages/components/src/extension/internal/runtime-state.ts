import type {
	ExtensionInteractionRecord,
	ExtensionModuleState,
	InteractionOfferDef,
	InteractionSessionDef,
	InteractionSurfaceDef,
} from '@pluxel/runtime/web/extensions'

type ManifestDiagnosticsSnapshot = {
	interactions: ExtensionInteractionRecord[]
	offers: InteractionOfferDef[]
	surfaces: InteractionSurfaceDef[]
	sessions: InteractionSessionDef[]
}

const EMPTY_DIAGNOSTICS: ManifestDiagnosticsSnapshot = {
	interactions: [],
	offers: [],
	surfaces: [],
	sessions: [],
}

function isEqualModuleState(
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

function equalArrayByJson(left: unknown[], right: unknown[]): boolean {
	if (left === right) return true
	if (left.length !== right.length) return false
	for (let i = 0; i < left.length; i += 1) {
		try {
			if (JSON.stringify(left[i]) !== JSON.stringify(right[i])) return false
		} catch {
			if (left[i] !== right[i]) return false
		}
	}
	return true
}

function collectDiagnosticPluginNames(snapshot: ManifestDiagnosticsSnapshot): Set<string> {
	const names = new Set<string>()
	for (const item of snapshot.interactions) {
		if (item.targetPlugin) names.add(item.targetPlugin)
		if (item.providerPlugin) names.add(item.providerPlugin)
	}
	for (const item of snapshot.surfaces) names.add(item.pluginName)
	for (const item of snapshot.offers) names.add(item.pluginName)
	for (const item of snapshot.sessions) {
		names.add(item.pluginName)
		names.add(item.providerPluginName)
	}
	return names
}

class ExtensionRuntimeStateStore {
	private readonly listeners = new Set<() => void>()
	private readonly pluginListeners = new Map<string, Set<() => void>>()
	private readonly moduleStatesByPlugin = new Map<string, ExtensionModuleState>()
	private moduleStatesList: ExtensionModuleState[] | null = null
	private diagnostics: ManifestDiagnosticsSnapshot = EMPTY_DIAGNOSTICS
	private manifestSyncHandler: ((force?: boolean) => void | Promise<void>) | null = null

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

	getModuleState(pluginName: string): ExtensionModuleState | undefined {
		return this.moduleStatesByPlugin.get(pluginName)
	}

	getModuleStates(): ExtensionModuleState[] {
		if (this.moduleStatesList) return this.moduleStatesList
		this.moduleStatesList = Array.from(this.moduleStatesByPlugin.values()).sort((a, b) =>
			a.pluginName.localeCompare(b.pluginName),
		)
		return this.moduleStatesList
	}

	getDiagnostics(): ManifestDiagnosticsSnapshot {
		return this.diagnostics
	}

	upsertModuleState(state: ExtensionModuleState): boolean {
		const previous = this.moduleStatesByPlugin.get(state.pluginName)
		if (isEqualModuleState(previous, state)) return false
		this.moduleStatesByPlugin.set(state.pluginName, state)
		this.notify(new Set([state.pluginName]), true)
		return true
	}

	removeModuleState(pluginName: string): boolean {
		if (!this.moduleStatesByPlugin.delete(pluginName)) return false
		this.notify(new Set([pluginName]), true)
		return true
	}

	replaceModuleStates(nextStates?: ExtensionModuleState[]): boolean {
		const nextMap = new Map<string, ExtensionModuleState>()
		for (const state of nextStates ?? []) {
			if (!state?.pluginName) continue
			nextMap.set(state.pluginName, state)
		}

		const touched = new Set<string>()

		for (const pluginName of this.moduleStatesByPlugin.keys()) {
			if (nextMap.has(pluginName)) continue
			this.moduleStatesByPlugin.delete(pluginName)
			touched.add(pluginName)
		}

		for (const [pluginName, next] of nextMap.entries()) {
			const current = this.moduleStatesByPlugin.get(pluginName)
			if (isEqualModuleState(current, next)) continue
			this.moduleStatesByPlugin.set(pluginName, next)
			touched.add(pluginName)
		}

		if (touched.size === 0) return false
		this.notify(touched, true)
		return true
	}

	clearModuleStates(): boolean {
		if (this.moduleStatesByPlugin.size === 0) return false
		const touched = new Set(this.moduleStatesByPlugin.keys())
		this.moduleStatesByPlugin.clear()
		this.notify(touched, true)
		return true
	}

	replaceDiagnostics(next?: Partial<ManifestDiagnosticsSnapshot>): boolean {
		const normalized: ManifestDiagnosticsSnapshot = {
			interactions: Array.isArray(next?.interactions) ? next.interactions : [],
			offers: Array.isArray(next?.offers) ? next.offers : [],
			surfaces: Array.isArray(next?.surfaces) ? next.surfaces : [],
			sessions: Array.isArray(next?.sessions) ? next.sessions : [],
		}
		if (
			equalArrayByJson(this.diagnostics.interactions, normalized.interactions) &&
			equalArrayByJson(this.diagnostics.offers, normalized.offers) &&
			equalArrayByJson(this.diagnostics.surfaces, normalized.surfaces) &&
			equalArrayByJson(this.diagnostics.sessions, normalized.sessions)
		) {
			return false
		}

		const touched = collectDiagnosticPluginNames(this.diagnostics)
		for (const pluginName of collectDiagnosticPluginNames(normalized)) {
			touched.add(pluginName)
		}

		this.diagnostics = normalized
		this.notify(touched, false)
		return true
	}

	clearDiagnostics(): boolean {
		if (
			this.diagnostics.interactions.length === 0 &&
			this.diagnostics.offers.length === 0 &&
			this.diagnostics.surfaces.length === 0 &&
			this.diagnostics.sessions.length === 0
		) {
			return false
		}
		const touched = collectDiagnosticPluginNames(this.diagnostics)
		this.diagnostics = EMPTY_DIAGNOSTICS
		this.notify(touched, false)
		return true
	}

	setManifestSyncHandler(handler: ((force?: boolean) => void | Promise<void>) | null): void {
		this.manifestSyncHandler = handler
	}

	requestManifestSync(force = true): void {
		if (!this.manifestSyncHandler) return
		void this.manifestSyncHandler(force)
	}

	private notify(pluginNames: Set<string>, invalidateModuleStates: boolean): void {
		if (invalidateModuleStates) {
			this.moduleStatesList = null
		}
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

const extensionRuntimeStateStore = new ExtensionRuntimeStateStore()

export function subscribeExtensionRuntimeState(listener: () => void): () => void {
	return extensionRuntimeStateStore.subscribe(listener)
}

export function subscribePluginExtensionRuntimeState(
	pluginName: string,
	listener: () => void,
): () => void {
	return extensionRuntimeStateStore.subscribePlugin(pluginName, listener)
}

export function getExtensionModuleState(pluginName: string): ExtensionModuleState | undefined {
	return extensionRuntimeStateStore.getModuleState(pluginName)
}

export function getExtensionModuleStates(): ExtensionModuleState[] {
	return extensionRuntimeStateStore.getModuleStates()
}

export function upsertExtensionModuleState(state: ExtensionModuleState): boolean {
	return extensionRuntimeStateStore.upsertModuleState(state)
}

export function removeExtensionModuleState(pluginName: string): boolean {
	return extensionRuntimeStateStore.removeModuleState(pluginName)
}

export function replaceExtensionModuleStates(states?: ExtensionModuleState[]): boolean {
	return extensionRuntimeStateStore.replaceModuleStates(states)
}

export function clearExtensionModuleStates(): boolean {
	return extensionRuntimeStateStore.clearModuleStates()
}

export function getExtensionManifestDiagnostics(): ManifestDiagnosticsSnapshot {
	return extensionRuntimeStateStore.getDiagnostics()
}

export function replaceExtensionManifestDiagnostics(
	next?: Partial<ManifestDiagnosticsSnapshot>,
): boolean {
	return extensionRuntimeStateStore.replaceDiagnostics(next)
}

export function clearExtensionManifestDiagnostics(): boolean {
	return extensionRuntimeStateStore.clearDiagnostics()
}

export function setExtensionManifestSyncHandler(
	handler: ((force?: boolean) => void | Promise<void>) | null,
): void {
	extensionRuntimeStateStore.setManifestSyncHandler(handler)
}

export function requestExtensionManifestSync(force = true): void {
	extensionRuntimeStateStore.requestManifestSync(force)
}
