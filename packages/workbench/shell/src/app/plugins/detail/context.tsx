// context.tsx
import { createContext, useContext, type ReactNode } from 'react'
import type { PluginStatusEntry } from '../pluginOverview'
import type { PluginNodeAddress } from '@pluxel/core'
import type { PluginDependencyDetail } from '../pluginDependencyGraphSelectors'

export interface PluginScopeContextValue {
	owner: PluginNodeAddress
	pluginRoute: string
	pluginLabel: string
	description: string
	dependencyGraph: Readonly<{
		detail: PluginDependencyDetail | null
		isLoading: boolean
		isStale: boolean
		error?: string
	}>
	status: PluginStatusEntry
	refetch: () => Promise<void>
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
	}
}

export function usePluginDependencyDetail() {
	return usePluginScope().dependencyGraph
}
