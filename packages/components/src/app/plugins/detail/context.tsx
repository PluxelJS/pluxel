// context.tsx
import type React from 'react'
import { createContext, useContext } from 'react'
import type {
	PluginDependency,
	PluginStatusEntryLifecycleStage,
	PluginScope,
	Query,
} from '../../gqty'
import { schema } from '../../gqty'

export type PluginSourceKind = 'hmr' | 'package' | 'unknown'

export interface PluginSourceInfo {
	kind: PluginSourceKind
	moduleId: string | null
	packageName?: string | null
	version?: string | null
	tag?: string | null
}

export interface PluginScopeContextValue {
	pluginName: string
	description: string
	scope: PluginScope
	dependencies: readonly PluginDependency[]
	knownPluginNames: ReadonlySet<string>
	isRunning: boolean
	isEnabled: boolean
	lifecycleStage: PluginStatusEntryLifecycleStage
	isSyncing: boolean
	source: PluginSourceInfo
	refetch: () => Promise<void>
	/**
	 * 原子写入 GQty 代理树（用于全局乐观更新）
	 */
	write: (fn: (q: Query) => void) => void
}

const Ctx = createContext<PluginScopeContextValue | null>(null)

export function PluginScopeProvider({
	value,
	children,
}: {
	value: Omit<PluginScopeContextValue, 'write'> & { write?: (fn: (q: Query) => void) => void }
	children: React.ReactNode
}) {
	const withWrite: PluginScopeContextValue = {
		...value,
		write:
			value.write ??
			((fn) => {
				// 默认透传根查询代理，便于外部原子写入缓存
				fn(schema.query)
			}),
	}
	return <Ctx.Provider value={withWrite}>{children}</Ctx.Provider>
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
		isRunning: ctx.isRunning,
		isEnabled: ctx.isEnabled,
		lifecycleStage: ctx.lifecycleStage,
		isSyncing: ctx.isSyncing,
		source: ctx.source,
	}
}

export function usePluginDependencies() {
	return usePluginScope().dependencies
}
