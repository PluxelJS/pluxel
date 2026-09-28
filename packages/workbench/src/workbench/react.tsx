import { useEffect, useMemo, useSyncExternalStore } from 'react'
import {
	createRemoteValue,
	type RemoteValue,
	type RemoteValueOptions,
	type RemoteValueSnapshot,
} from './client.ts'
import {
	resolveWorkbenchHookValue,
	useWorkbenchReactRuntime,
	type WorkbenchHookValue,
	type WorkbenchRenderableDescriptor,
} from './react-context.tsx'

/** Returns the exact direct capability root(s) bound to this generated renderer. */
export function useWorkbench<Descriptor extends WorkbenchRenderableDescriptor>(
	descriptor: Descriptor,
): WorkbenchHookValue<Descriptor> {
	return resolveWorkbenchHookValue(useWorkbenchReactRuntime(), descriptor)
}

/** React owner for `createRemoteValue()`; dependencies create a new isolated read identity. */
export function useRemoteValue<Value>(
	options: RemoteValueOptions<Value>,
	dependencies: readonly unknown[] = [],
): RemoteValueSnapshot<Value> {
	// Render creates only local state. A discarded render must not start remote work.
	const owner = useMemo(() => {
		let snapshot: RemoteValueSnapshot<Value> = Object.freeze({ state: 'loading' })
		const listeners = new Set<() => void>()
		return {
			options,
			mounts: 0,
			remote: undefined as RemoteValue<Value> | undefined,
			unsubscribe: undefined as (() => void) | undefined,
			getSnapshot: () => snapshot,
			subscribe(listener: () => void) {
				listeners.add(listener)
				return () => {
					listeners.delete(listener)
				}
			},
			publish(next: RemoteValueSnapshot<Value>) {
				snapshot = next
				// Subscription changes during notification apply to the next publication.
				const currentListeners = [...listeners]
				for (const listener of currentListeners) listener()
			},
		}
	}, dependencies)
	useEffect(() => {
		owner.options = options
	})
	useEffect(() => {
		owner.mounts += 1
		if (!owner.remote) {
			const remote = createRemoteValue<Value>({
				read: () => owner.options.read(),
				...(owner.options.subscribe
					? { subscribe: (invalidate: () => void) => owner.options.subscribe!(invalidate) }
					: {}),
			})
			owner.remote = remote
			owner.unsubscribe = remote.subscribe(() => owner.publish(remote.getSnapshot()))
			owner.publish(remote.getSnapshot())
		}
		return () => {
			owner.mounts -= 1
			queueMicrotask(() => {
				if (owner.mounts !== 0) return
				owner.unsubscribe?.()
				owner.unsubscribe = undefined
				owner.remote?.[Symbol.dispose]()
				owner.remote = undefined
			})
		}
	}, [owner])
	return useSyncExternalStore(owner.subscribe, owner.getSnapshot, owner.getSnapshot)
}

export { WorkbenchPane, WorkbenchPaneLayout, useWorkbenchPaneLayout } from './ui-pane.tsx'
export { createWorkbenchRenderer, WorkbenchRendererError } from './renderer-scope.tsx'
export type {
	WorkbenchMutationExecutionContext,
	WorkbenchMutationOptions,
	WorkbenchMutationResource,
	WorkbenchMutationState,
	WorkbenchQueryExecutionContext,
	WorkbenchQueryFamilyResource,
	WorkbenchQueryInvalidation,
	WorkbenchQueryOptions,
	WorkbenchQueryResource,
	WorkbenchQueryResult,
	WorkbenchQueryRetry,
	WorkbenchQueryRetryDelay,
	WorkbenchQuerySubscriptionContext,
	WorkbenchRendererErrorCode,
	WorkbenchRendererScope,
	WorkbenchResourceKey,
	WorkbenchZeroProps,
} from './renderer-scope.tsx'
export type {
	WorkbenchPaneCollapseAt,
	WorkbenchPaneLayoutControls,
	WorkbenchPaneLayoutMode,
	WorkbenchPaneLayoutProps,
	WorkbenchPaneProps,
	WorkbenchPaneRole,
	WorkbenchPaneSize,
} from './ui-pane.tsx'
export type {
	WorkbenchConfirmInput,
	WorkbenchDocument,
	WorkbenchDocumentInput,
	WorkbenchDocumentTitle,
	WorkbenchHostFacade,
	WorkbenchHookValue,
	WorkbenchNavigation,
	WorkbenchNotificationInput,
} from './react-context.tsx'

export type { WorkbenchManagementOperations } from './management.ts'
