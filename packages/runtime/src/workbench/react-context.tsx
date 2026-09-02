import { createContext, useContext, type ReactNode } from 'react'
import type { WorkbenchDeclarationIdentity } from '@pluxel/core/federation'
import type { RpcStub, RpcTarget } from '../capnweb'
import type { WorkbenchOpenedClientValue, WorkbenchOpenedViewHandle } from './client'
import {
	readWorkbenchDescriptor,
	type WorkbenchDescriptorApi,
	type WorkbenchDescriptorConsumerApi,
	type WorkbenchRenderableDescriptor,
} from './definition'
import type { WorkbenchPaneLayoutRenderer } from './ui-pane'

export type { WorkbenchRenderableDescriptor } from './definition'

type ApiOf<Descriptor> = WorkbenchDescriptorApi<Descriptor>

type ConsumerApiOf<Descriptor> = WorkbenchDescriptorConsumerApi<Descriptor>

// Keep an explicitly `any` descriptor permissive while preserving exact RpcStub inference for
// generated projections and every author-defined descriptor.
type StubOf<Api> = 0 extends 1 & Api ? any : Api extends RpcTarget ? RpcStub<Api> : never

export type WorkbenchHookValue<Descriptor extends WorkbenchRenderableDescriptor> =
	Descriptor extends Readonly<{ kind: 'view' }>
		? Readonly<{ api: StubOf<ApiOf<Descriptor>>; host: WorkbenchHostFacade }>
		: [ConsumerApiOf<Descriptor>] extends [never]
			? Readonly<{ provider: StubOf<ApiOf<Descriptor>>; host: WorkbenchHostFacade }>
			: Readonly<{
					provider: StubOf<ApiOf<Descriptor>>
					consumer: StubOf<ConsumerApiOf<Descriptor> & RpcTarget>
					host: WorkbenchHostFacade
				}>

export type WorkbenchNotificationInput = Readonly<{
	title?: string
	message: string
	tone?: 'info' | 'success' | 'warning' | 'error'
}>

export type WorkbenchConfirmInput = Readonly<{
	title?: string
	message: string
	confirmLabel?: string
	cancelLabel?: string
	tone?: 'default' | 'danger'
}>

export type WorkbenchDocumentInput = Readonly<{
	path: string
	title: string
	meta?: string
}>

export type WorkbenchNavigation = Readonly<{
	navigate(path: string): void
	openDocument(input: WorkbenchDocumentInput): void
}>

export type WorkbenchDocumentTitle = Readonly<{
	title: string
	meta?: string
}>

export type WorkbenchDocument = Readonly<{
	params: Readonly<Record<string, string>>
	setDirty(dirty: boolean): void
	setTitle(input: WorkbenchDocumentTitle): void
}>

/** Fixed browser behavior available to every hosted Plugin renderer. */
export type WorkbenchHostFacade = Readonly<{
	locale: string
	colorScheme: 'light' | 'dark'
	notify(input: WorkbenchNotificationInput): void
	confirm(input: WorkbenchConfirmInput): Promise<boolean>
	navigation: WorkbenchNavigation | null
	document: WorkbenchDocument | null
}>

export type WorkbenchReactRuntime = Readonly<{
	identity: WorkbenchDeclarationIdentity
	opened: WorkbenchOpenedClientValue
	host: WorkbenchHostFacade
	paneLayoutRenderer?: WorkbenchPaneLayoutRenderer
}>

/** @internal Host-to-generated-wrapper ABI. Never pass this object to the Plugin component. */
export type WorkbenchBridgePayload = Readonly<{
	profile: 1
	handle: WorkbenchOpenedViewHandle
	host: WorkbenchHostFacade
	paneLayoutRenderer?: WorkbenchPaneLayoutRenderer
}>

const WorkbenchReactContext = createContext<WorkbenchReactRuntime | null>(null)

/** @internal Generated wrapper only. */
export function WorkbenchReactContextProvider({
	value,
	children,
}: Readonly<{ value: WorkbenchReactRuntime; children: ReactNode }>) {
	return <WorkbenchReactContext.Provider value={value}>{children}</WorkbenchReactContext.Provider>
}

/** @internal Used by descriptor hooks and Pane Kit only. */
export function useWorkbenchReactRuntime(): WorkbenchReactRuntime {
	const value = useContext(WorkbenchReactContext)
	if (!value) throw new Error('Workbench renderer is outside its generated Bridge')
	return value
}

/** @internal Shared exact-descriptor projection for low-level and scoped renderer hooks. */
export function resolveWorkbenchHookValue<Descriptor extends WorkbenchRenderableDescriptor>(
	runtime: WorkbenchReactRuntime,
	descriptor: Descriptor,
): WorkbenchHookValue<Descriptor> {
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
