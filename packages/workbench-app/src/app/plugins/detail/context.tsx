// context.tsx
import { createContext, useContext, type ReactNode } from 'react'
import type { PluginSourceSnapshot } from '../../../runtime'
import type {
	PluginDependency,
	PluginStatusEntry,
	PluginStatusEntryLifecycleStage,
} from '../pluginOverview'
import type { PluginNodeAddress } from '@pluxel/core'

export type PluginSourceKind = PluginSourceSnapshot['kind']

export type PluginSourceInfo = {
	kind: PluginSourceKind
	moduleId: string | null
	packageName: string | null
	version: string | null
	tag: string | null
}

export interface PluginScopeContextValue {
	owner: PluginNodeAddress
	pluginRoute: string
	pluginLabel: string
	description: string
	dependencies: readonly PluginDependency[]
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
		owner: ctx.owner,
		pluginRoute: ctx.pluginRoute,
		pluginLabel: ctx.pluginLabel,
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
