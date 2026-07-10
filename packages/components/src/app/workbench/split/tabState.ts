import { useStore } from '@tanstack/react-store'
import { useCallback, useMemo } from 'react'
import { useWorkbenchTabIdentity } from '../context'
import { setWorkbenchActiveTabState, workbenchStore } from '../store'
import { mergeLayout } from './storage'
import type { SplitViewLayout } from './view'

type NumericLayout = Record<string, number>
type TabStateRecord = Record<string, unknown>

function hasSameState<T extends TabStateRecord>(left: T, right: T) {
	const keys = Object.keys(left)
	if (keys.length !== Object.keys(right).length) return false
	return keys.every((key) => Object.is(left[key], right[key]))
}

export function useResolvedWorkbenchTabState<T>(
	scope: string,
	resolve: (value: unknown) => T,
) {
	const { activeTabId } = useWorkbenchTabIdentity()
	const scopedValue = useStore(workbenchStore, (state) =>
		activeTabId ? state.uiState.tabState[activeTabId]?.[scope] : undefined,
	)
	return useMemo(() => resolve(scopedValue), [resolve, scopedValue])
}

export function usePatchedWorkbenchTabState<T extends TabStateRecord>(
	scope: string,
	resolve: (value: unknown) => T,
) {
	const { activeTabId } = useWorkbenchTabIdentity()
	const state = useResolvedWorkbenchTabState(scope, resolve)

	const patchState = useCallback(
		(patch: Partial<T>) => {
			const nextState = { ...state, ...patch }
			if (hasSameState(state, nextState)) return
			setWorkbenchActiveTabState(activeTabId, scope, nextState)
		},
		[activeTabId, scope, state],
	)

	return [state, patchState] as const
}

export function useWorkbenchSplitLayout<T extends NumericLayout>(
	scope: string,
	resolve: (value: unknown) => T,
	sanitize: (layout: T) => T,
) {
	const { activeTabId } = useWorkbenchTabIdentity()
	const layout = useResolvedWorkbenchTabState(scope, resolve)

	const handleLayoutChanged = useCallback(
		(nextLayout: SplitViewLayout) => {
			setWorkbenchActiveTabState(activeTabId, scope, mergeLayout(layout, nextLayout, sanitize))
		},
		[activeTabId, layout, sanitize, scope],
	)

	return [layout, handleLayoutChanged] as const
}
