import type { PluginNodeAddress } from '@pluxel/core'
import type {
	WorkbenchDeclarationIdentity,
	WorkbenchOpenableIdentity,
} from '@pluxel/core/federation'
import type { RpcTarget } from '../capnweb'
import type { WorkbenchPlacement } from './definition'

export type WorkbenchFederatedViewRef = Readonly<{
	profile: 1
	producer: string
	buildRevision: string
	manifestUrl: string
	expose: `./views/${string}`
	descriptor: WorkbenchDeclarationIdentity
}>

export type WorkbenchLayoutTarget = Readonly<{
	node: PluginNodeAddress
	displayName: string
}>

export type WorkbenchLayoutEntry = Readonly<{
	descriptor: WorkbenchOpenableIdentity
	target: WorkbenchLayoutTarget
	renderer: PluginNodeAddress
	definitionRevisions: Readonly<{
		target: number
		renderer: number
	}>
	placement: WorkbenchPlacement
	federatedViewRef: WorkbenchFederatedViewRef
}>

export type WorkbenchLayout = Readonly<{
	profile: 1
	revision: number
	target: WorkbenchLayoutTarget | null
	entries: readonly WorkbenchLayoutEntry[]
}>

export type WorkbenchLayoutInput = Readonly<{
	target: PluginNodeAddress | null
}>

export type WorkbenchOpenViewInput = Readonly<{
	layoutRevision: number
	target: PluginNodeAddress
	descriptor: WorkbenchOpenableIdentity
	location?: string
}>

export type WorkbenchOpenViewFailureCode =
	| 'layout_changed'
	| 'target_unavailable'
	| 'factory_failed'
	| 'factory_timeout'
	| 'quota_exceeded'

export type WorkbenchOpenedLocalView = Readonly<{
	kind: 'local'
	api: RpcTarget
	params: Readonly<Record<string, string>>
	federatedViewRef: WorkbenchFederatedViewRef
}>

export type WorkbenchOpenedAttachment = Readonly<{
	kind: 'attachment'
	provider: RpcTarget
	params: Readonly<Record<string, string>>
	federatedViewRef: WorkbenchFederatedViewRef
	consumer?: RpcTarget
}>

export type WorkbenchOpenedView = WorkbenchOpenedLocalView | WorkbenchOpenedAttachment

export type WorkbenchOpenViewResult =
	| Readonly<{ ok: true; value: WorkbenchOpenedView }>
	| Readonly<{ ok: false; code: WorkbenchOpenViewFailureCode }>

export interface WorkbenchSessionApi extends RpcTarget {
	layout(input: WorkbenchLayoutInput): WorkbenchLayout
	openView(input: WorkbenchOpenViewInput): Promise<WorkbenchOpenViewResult>
}
