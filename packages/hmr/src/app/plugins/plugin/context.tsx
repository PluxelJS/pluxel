import { createContext, useContext } from 'react'
import type { PluginScope } from '../../gqty'

export type PluginDependencySnapshot = {
	name: string
	optional: boolean
	isRunning: boolean
}

export interface PluginScopeContextValue {
	pluginName: string
	description: string
	scope: PluginScope
	dependencies: readonly PluginDependencySnapshot[]
	isRunning: boolean
	isSyncing: boolean
	refetch: () => Promise<void>
}

const PluginScopeContext = createContext<PluginScopeContextValue | null>(null)

export const PluginScopeProvider = PluginScopeContext.Provider

export function usePluginScope(): PluginScopeContextValue {
	const ctx = useContext(PluginScopeContext)
	if (!ctx) {
		throw new Error('usePluginScope must be used within a PluginScopeProvider')
	}
	return ctx
}

export function useOptionalPluginScope(): PluginScopeContextValue | null {
	return useContext(PluginScopeContext)
}

export function usePluginMeta() {
	const ctx = usePluginScope()
	return {
		pluginName: ctx.pluginName,
		description: ctx.description,
		isRunning: ctx.isRunning,
		isSyncing: ctx.isSyncing,
	}
}

export function usePluginDependencies() {
	const ctx = usePluginScope()
	return ctx.dependencies
}
