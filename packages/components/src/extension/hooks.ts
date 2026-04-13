import { useCallback, useSyncExternalStore } from 'react'
import {
	getPluginUiModuleRevision,
	getPluginUiRegistryRevision,
	subscribePluginUiModuleChanges,
	subscribePluginUiRegistryChanges,
} from './internal/pluginUiRegistry'
import {
	getExtensionModuleState,
	getExtensionModuleStates,
	getExtensionManifestDiagnostics,
	requestExtensionManifestSync,
	subscribeExtensionRuntimeState,
	subscribePluginExtensionRuntimeState,
} from './internal/runtime-state'
import type {
	ExtensionInteractionRecord,
	InteractionOfferDef,
	InteractionSessionDef,
	InteractionSurfaceDef,
	ExtensionModuleState,
} from '@pluxel/runtime/web/extensions'
import {
	hasPluginExtensionDiagnostics,
	summarizePluginExtensionDiagnostics,
	type PluginExtensionDiagnosticsSnapshot,
	type PluginExtensionDiagnosticsSummary,
} from './diagnostics'

/**
 * 插件 UI 模块注册表版本号。
 */
export function usePluginUiVersion(pluginName?: string): number {
	const subscribe = useCallback(
		(listener: () => void) => {
			if (pluginName) return subscribePluginUiModuleChanges(pluginName, listener)
			return subscribePluginUiRegistryChanges(listener)
		},
		[pluginName],
	)

	const getSnapshot = useCallback(() => {
		if (pluginName) return getPluginUiModuleRevision(pluginName)
		return getPluginUiRegistryRevision()
	}, [pluginName])

	return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function useExtensionModuleState(pluginName: string) {
	const subscribe = useCallback(
		(listener: () => void) => subscribePluginExtensionRuntimeState(pluginName, listener),
		[pluginName],
	)
	const getSnapshot = useCallback(() => getExtensionModuleState(pluginName), [pluginName])
	return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function useExtensionModuleStates() {
	return useSyncExternalStore(
		subscribeExtensionRuntimeState,
		getExtensionModuleStates,
		getExtensionModuleStates,
	)
}

export function useExtensionManifestDiagnostics() {
	return useSyncExternalStore(
		subscribeExtensionRuntimeState,
		getExtensionManifestDiagnostics,
		getExtensionManifestDiagnostics,
	)
}

export function usePluginExtensionDiagnostics(pluginName: string): {
	incoming: ExtensionInteractionRecord[]
	outgoing: ExtensionInteractionRecord[]
	surfaces: InteractionSurfaceDef[]
	offers: InteractionOfferDef[]
	sessions: InteractionSessionDef[]
} {
	const snapshot = useExtensionManifestDiagnostics()
	return {
		incoming: snapshot.interactions.filter((item) => item.targetPlugin === pluginName),
		outgoing: snapshot.interactions.filter((item) => item.providerPlugin === pluginName),
		surfaces: snapshot.surfaces.filter((item) => item.pluginName === pluginName),
		offers: snapshot.offers.filter((item) => item.pluginName === pluginName),
		sessions: snapshot.sessions.filter(
			(item) => item.pluginName === pluginName || item.providerPluginName === pluginName,
		),
	}
}

export type PluginUiStatusSnapshot = {
	module: ExtensionModuleState | undefined
	diagnostics: PluginExtensionDiagnosticsSnapshot
	summary: PluginExtensionDiagnosticsSummary
	hasDiagnostics: boolean
	hasIssues: boolean
	retrySync(force?: boolean): void
}

export function usePluginUiStatus(pluginName: string): PluginUiStatusSnapshot {
	const module = useExtensionModuleState(pluginName)
	const diagnostics = usePluginExtensionDiagnostics(pluginName)
	const summary = summarizePluginExtensionDiagnostics(diagnostics)
	const retrySync = useCallback((force = true) => requestExtensionManifestSync(force), [])
	return {
		module,
		diagnostics,
		summary,
		hasDiagnostics: hasPluginExtensionDiagnostics(diagnostics, summary),
		hasIssues: summary.issues.length > 0,
		retrySync,
	}
}
