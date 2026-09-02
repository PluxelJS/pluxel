import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { createRemoteValue, type RemoteValueOptions, type RemoteValueSnapshot } from './client'
import {
	resolveWorkbenchHookValue,
	useWorkbenchReactRuntime,
	type WorkbenchHookValue,
	type WorkbenchRenderableDescriptor,
} from './react-context'

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
	const optionsRef = useRef(options)
	optionsRef.current = options
	// The dependency array is intentionally caller-controlled for closures over mutable inputs.
	const remote = useMemo(
		() =>
			createRemoteValue<Value>({
				read: () => optionsRef.current.read(),
				...(options.subscribe
					? { subscribe: (invalidate) => optionsRef.current.subscribe!(invalidate) }
					: {}),
			}),
		dependencies,
	)
	const ownership = useMemo(() => ({ mounts: 0, remote }), [remote])
	useEffect(() => {
		ownership.mounts += 1
		return () => {
			ownership.mounts -= 1
			queueMicrotask(() => {
				if (ownership.mounts === 0) ownership.remote[Symbol.dispose]()
			})
		}
	}, [ownership])
	return useSyncExternalStore(remote.subscribe, remote.getSnapshot, remote.getSnapshot)
}

export { WorkbenchPane, WorkbenchPaneLayout, useWorkbenchPaneLayout } from './ui-pane'
export { createWorkbenchRenderer, WorkbenchRendererError } from './renderer-scope'
export type {
	WorkbenchKeyedQueryResource,
	WorkbenchMutationExecutionContext,
	WorkbenchMutationResource,
	WorkbenchMutationState,
	WorkbenchQueryExecutionContext,
	WorkbenchQueryInvalidation,
	WorkbenchQueryResource,
	WorkbenchQueryResult,
	WorkbenchQueryRetry,
	WorkbenchRendererErrorCode,
	WorkbenchRendererKeyedQueryOptions,
	WorkbenchRendererMutationOptions,
	WorkbenchRendererQueryOptions,
	WorkbenchRendererScope,
	WorkbenchResourceKey,
	WorkbenchZeroProps,
} from './renderer-scope'
export type {
	WorkbenchPaneCollapseAt,
	WorkbenchPaneLayoutControls,
	WorkbenchPaneLayoutMode,
	WorkbenchPaneLayoutProps,
	WorkbenchPaneProps,
	WorkbenchPaneRole,
	WorkbenchPaneSize,
} from './ui-pane'
export type {
	WorkbenchConfirmInput,
	WorkbenchDocument,
	WorkbenchDocumentInput,
	WorkbenchDocumentTitle,
	WorkbenchHostFacade,
	WorkbenchHookValue,
	WorkbenchNavigation,
	WorkbenchNotificationInput,
} from './react-context'
