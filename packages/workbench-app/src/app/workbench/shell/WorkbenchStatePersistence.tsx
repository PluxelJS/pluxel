import { useEffect } from 'react'
import { useStore } from '@tanstack/react-store'
import { createPersistedWorkbenchState, WORKBENCH_STORAGE_KEY } from '../state'
import type { WorkspaceController } from '../store'

export function WorkbenchStatePersistence({
	controller,
}: {
	controller: WorkspaceController
}): null {
	const uiState = useStore(controller.store, (state) => state.uiState)

	useEffect(() => {
		if (typeof window === 'undefined') return undefined
		const persist = () => {
			try {
				window.localStorage.setItem(
					WORKBENCH_STORAGE_KEY,
					JSON.stringify(createPersistedWorkbenchState(uiState)),
				)
			} catch {}
		}
		if (typeof window.requestIdleCallback === 'function') {
			const handle = window.requestIdleCallback(persist, { timeout: 240 })
			return () => window.cancelIdleCallback(handle)
		}
		const handle = window.setTimeout(persist, 120)
		return () => window.clearTimeout(handle)
	}, [uiState])

	return null
}
