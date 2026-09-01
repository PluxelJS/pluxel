import type { PluginNodeAddress } from '@pluxel/core'
import type {
	WorkbenchDeclarationIdentity,
	WorkbenchOpenableIdentity,
	WorkbenchPageIdentity,
} from '@pluxel/core/federation'
import type { WorkbenchStandardPagePlanV1 } from '@pluxel/core/internal'
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

export type WorkbenchFederatedLayoutEntry = Readonly<{
	descriptor: Exclude<WorkbenchOpenableIdentity, WorkbenchPageIdentity>
	target: WorkbenchLayoutTarget
	renderer: PluginNodeAddress
	definitionRevisions: Readonly<{
		target: number
		renderer: number
	}>
	placement: WorkbenchPlacement
	federatedViewRef: WorkbenchFederatedViewRef
}>

export type WorkbenchStandardPageRef = Readonly<{
	profile: 1
	digest: string
	descriptor: WorkbenchPageIdentity
}>

export type WorkbenchStandardPageLayoutEntry = Readonly<{
	descriptor: WorkbenchPageIdentity
	target: WorkbenchLayoutTarget
	definitionRevisions: Readonly<{
		target: number
	}>
	placement: WorkbenchPlacement
	standardPageRef: WorkbenchStandardPageRef
}>

export type WorkbenchLayoutEntry = WorkbenchFederatedLayoutEntry | WorkbenchStandardPageLayoutEntry

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

export type WorkbenchOpenedStandardPage = Readonly<{
	kind: 'page'
	params: Readonly<Record<string, string>>
	standardPageRef: WorkbenchStandardPageRef
	plan: WorkbenchStandardPagePlanV1
}>

export type WorkbenchOpenedView =
	| WorkbenchOpenedLocalView
	| WorkbenchOpenedAttachment
	| WorkbenchOpenedStandardPage

export type WorkbenchOpenViewResult =
	| Readonly<{ ok: true; value: WorkbenchOpenedView }>
	| Readonly<{ ok: false; code: WorkbenchOpenViewFailureCode }>

export interface WorkbenchSessionApi extends RpcTarget {
	layout(input: WorkbenchLayoutInput): WorkbenchLayout
	openView(input: WorkbenchOpenViewInput): Promise<WorkbenchOpenViewResult>
}
