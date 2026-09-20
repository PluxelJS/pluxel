import { useEffect, useRef } from 'react'
import { createPersistedWorkbenchState, WORKBENCH_STORAGE_KEY } from '../state'
import type { WorkspaceController } from '../store'

export function WorkbenchStatePersistence({
	controller,
}: {
	controller: WorkspaceController
}): null {
	const lastPersistedValue = useRef<string | undefined>(undefined)

	useEffect(() => {
		if (typeof window === 'undefined') return undefined
		let observedState = controller.state.uiState
		let dirty = true
		let cancelScheduled: (() => void) | undefined

		const persist = () => {
			cancelScheduled?.()
			cancelScheduled = undefined
			if (!dirty) return
			dirty = false
			try {
				const serialized = JSON.stringify(createPersistedWorkbenchState(controller.state.uiState))
				if (serialized === lastPersistedValue.current) return
				window.localStorage.setItem(WORKBENCH_STORAGE_KEY, serialized)
				lastPersistedValue.current = serialized
			} catch {}
		}
		const schedule = () => {
			if (cancelScheduled) return
			if (typeof window.requestIdleCallback === 'function') {
				const handle = window.requestIdleCallback(persist, { timeout: 240 })
				cancelScheduled = () => window.cancelIdleCallback(handle)
			} else {
				const handle = window.setTimeout(persist, 120)
				cancelScheduled = () => window.clearTimeout(handle)
			}
		}
		const subscription = controller.store.subscribe(() => {
			const nextState = controller.state.uiState
			if (nextState === observedState) return
			observedState = nextState
			dirty = true
			schedule()
		})
		const onVisibilityChange = () => {
			if (document.visibilityState === 'hidden') persist()
		}
		schedule()
		window.addEventListener('pagehide', persist)
		document.addEventListener('visibilitychange', onVisibilityChange)
		return () => {
			subscription.unsubscribe()
			window.removeEventListener('pagehide', persist)
			document.removeEventListener('visibilitychange', onVisibilityChange)
			persist()
		}
	}, [controller])

	return null
}
