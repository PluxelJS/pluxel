import { createContext, useContext, type ReactNode } from 'react'
import type { WorkbenchDeclarationIdentity } from '@pluxel/core/federation'
import type { WorkbenchOpenedClientValue, WorkbenchOpenedViewHandle } from './client'
import type { WorkbenchPaneLayoutRenderer } from './ui-pane'

export type { WorkbenchRenderableDescriptor } from './definition'

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
