import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import type { RpcStub, RpcTarget } from '../capnweb'
import { createRemoteValue, type RemoteValueOptions, type RemoteValueSnapshot } from './client'
import {
	readWorkbenchDescriptor,
	type WorkbenchDescriptorApi,
	type WorkbenchDescriptorConsumerApi,
} from './definition'
import {
	useWorkbenchReactRuntime,
	type WorkbenchHostFacade,
	type WorkbenchRenderableDescriptor,
} from './react-context'

type ApiOf<Descriptor> = WorkbenchDescriptorApi<Descriptor>

type ConsumerApiOf<Descriptor> = WorkbenchDescriptorConsumerApi<Descriptor>

export type WorkbenchHookValue<Descriptor extends WorkbenchRenderableDescriptor> =
	Descriptor extends Readonly<{ kind: 'view' }>
		? Readonly<{ api: RpcStub<ApiOf<Descriptor>>; host: WorkbenchHostFacade }>
		: [ConsumerApiOf<Descriptor>] extends [never]
			? Readonly<{ provider: RpcStub<ApiOf<Descriptor>>; host: WorkbenchHostFacade }>
			: Readonly<{
					provider: RpcStub<ApiOf<Descriptor>>
					consumer: RpcStub<ConsumerApiOf<Descriptor> & RpcTarget>
					host: WorkbenchHostFacade
				}>

/** Returns the exact direct capability root(s) bound to this generated renderer. */
export function useWorkbench<Descriptor extends WorkbenchRenderableDescriptor>(
	descriptor: Descriptor,
): WorkbenchHookValue<Descriptor> {
	const runtime = useWorkbenchReactRuntime()
	if (descriptor !== runtime.descriptor) {
		throw new Error('useWorkbench() descriptor does not belong to this renderer')
	}
	const metadata = readWorkbenchDescriptor(descriptor)
	if (
		(metadata.kind !== 'view' && metadata.kind !== 'attachment') ||
		metadata.kind !== runtime.identity.kind ||
		metadata.key !== runtime.identity.key
	) {
		throw new Error('useWorkbench() descriptor identity does not match this renderer')
	}
	if (metadata.kind === 'view') {
		if (runtime.opened.kind !== 'local') {
			throw new Error('Workbench View renderer received Attachment roots')
		}
		return Object.freeze({ api: runtime.opened.api, host: runtime.host }) as never
	}
	if (runtime.opened.kind !== 'attachment') {
		throw new Error('Workbench Attachment renderer received a local View root')
	}
	const consumer = runtime.opened.consumer
	return Object.freeze({
		provider: runtime.opened.provider,
		...(consumer === undefined ? {} : { consumer }),
		host: runtime.host,
	}) as never
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
	WorkbenchNavigation,
	WorkbenchNotificationInput,
} from './react-context'
