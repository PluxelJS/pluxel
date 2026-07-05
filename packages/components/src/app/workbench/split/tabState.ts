import { useCallback, useMemo } from 'react'
import { useWorkbenchTabs } from '../context'
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
	const { getActiveTabState } = useWorkbenchTabs()
	return useMemo(() => resolve(getActiveTabState(scope)), [getActiveTabState, resolve, scope])
}

export function usePatchedWorkbenchTabState<T extends TabStateRecord>(
	scope: string,
	resolve: (value: unknown) => T,
) {
	const { setActiveTabState } = useWorkbenchTabs()
	const state = useResolvedWorkbenchTabState(scope, resolve)

	const patchState = useCallback(
		(patch: Partial<T>) => {
			const nextState = { ...state, ...patch }
			if (hasSameState(state, nextState)) return
			setActiveTabState(scope, nextState)
		},
		[scope, setActiveTabState, state],
	)

	return [state, patchState] as const
}

export function useWorkbenchSplitLayout<T extends NumericLayout>(
	scope: string,
	resolve: (value: unknown) => T,
	sanitize: (layout: T) => T,
) {
	const { setActiveTabState } = useWorkbenchTabs()
	const layout = useResolvedWorkbenchTabState(scope, resolve)

	const handleLayoutChanged = useCallback(
		(nextLayout: SplitViewLayout) => {
			setActiveTabState(scope, mergeLayout(layout, nextLayout, sanitize))
		},
		[layout, sanitize, scope, setActiveTabState],
	)

	return [layout, handleLayoutChanged] as const
}
