// context.tsx
import { createContext, useContext, type ReactNode } from 'react'
import type {
	PluginDependency,
	PluginSourceInfo as GqlPluginSourceInfo,
	PluginSourceInfoKind,
	PluginStatusEntry,
	PluginStatusEntryLifecycleStage,
	PluginScope,
} from '../../gqty'

export type PluginSourceKind = PluginSourceInfoKind

export type PluginSourceInfo = Omit<GqlPluginSourceInfo, '__typename' | 'kind'> & {
	kind: PluginSourceKind
}

export interface PluginScopeContextValue {
	pluginName: string
	description: string
	scope: PluginScope
	dependencies: readonly PluginDependency[]
	knownPluginNames: ReadonlySet<string>
	status: PluginStatusEntry | null
	isRunning: boolean
	isEnabled: boolean
	lifecycleStage: PluginStatusEntryLifecycleStage
	isSyncing: boolean
	source: PluginSourceInfo
	refetch: () => Promise<void>
	setStatusOverride?: (next: {
		isRunning: boolean
		isEnabled: boolean
		lifecycleStage: PluginStatusEntryLifecycleStage
	}) => void
}

const Ctx = createContext<PluginScopeContextValue | null>(null)

export function PluginScopeProvider({
	value,
	children,
}: {
	value: PluginScopeContextValue
	children: ReactNode
}) {
	return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function usePluginScope(): PluginScopeContextValue {
	const ctx = useContext(Ctx)
	if (!ctx) throw new Error('usePluginScope must be used within a PluginScopeProvider')
	return ctx
}

export function usePluginMeta() {
	const ctx = usePluginScope()
	return {
		pluginName: ctx.pluginName,
		description: ctx.description,
		status: ctx.status,
		isRunning: ctx.isRunning,
		isEnabled: ctx.isEnabled,
		lifecycleStage: ctx.lifecycleStage,
		isSyncing: ctx.isSyncing,
		source: ctx.source,
	}
}

export function usePluginStatus() {
	const ctx = usePluginScope()
	return {
		status: ctx.status,
		isRunning: ctx.isRunning,
		isEnabled: ctx.isEnabled,
		lifecycleStage: ctx.lifecycleStage,
		source: ctx.source,
	}
}

export function usePluginDependencies() {
	return usePluginScope().dependencies
}
