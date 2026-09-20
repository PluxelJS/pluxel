import { useStore } from '@tanstack/react-store'
import { useCallback, useMemo } from 'react'
import { useActiveWorkbenchTabId, useWorkspaceController } from '../context'
import { mergeLayout } from './storage'
import type { SplitViewLayout } from './view'

type NumericLayout = Record<string, number>
type TabStateRecord = Record<string, unknown>

function hasSameState<T extends TabStateRecord>(left: T, right: T) {
	const keys = Object.keys(left)
	if (keys.length !== Object.keys(right).length) return false
	return keys.every((key) => Object.is(left[key], right[key]))
}

export function useResolvedWorkbenchTabState<T>(scope: string, resolve: (value: unknown) => T) {
	const activeTabId = useActiveWorkbenchTabId()
	const workspace = useWorkspaceController()
	const scopedValue = useStore(workspace.store, (state) =>
		activeTabId ? state.uiState.tabState[activeTabId]?.[scope] : undefined,
	)
	return useMemo(() => resolve(scopedValue), [resolve, scopedValue])
}

export function usePatchedWorkbenchTabState<T extends TabStateRecord>(
	scope: string,
	resolve: (value: unknown) => T,
) {
	const activeTabId = useActiveWorkbenchTabId()
	const workspace = useWorkspaceController()
	const state = useResolvedWorkbenchTabState(scope, resolve)

	const patchState = useCallback(
		(patch: Partial<T>) => {
			const nextState = { ...state, ...patch }
			if (hasSameState(state, nextState)) return
			workspace.setActiveTabState(activeTabId, scope, nextState)
		},
		[activeTabId, scope, state, workspace],
	)

	return [state, patchState] as const
}

export function useWorkbenchSplitLayout<T extends NumericLayout>(
	scope: string,
	resolve: (value: unknown) => T,
	sanitize: (layout: T) => T,
) {
	const activeTabId = useActiveWorkbenchTabId()
	const workspace = useWorkspaceController()
	const layout = useResolvedWorkbenchTabState(scope, resolve)

	const handleLayoutChanged = useCallback(
		(nextLayout: SplitViewLayout) => {
			workspace.setActiveTabState(activeTabId, scope, mergeLayout(layout, nextLayout, sanitize))
		},
		[activeTabId, layout, sanitize, scope, workspace],
	)

	return [layout, handleLayoutChanged] as const
}
