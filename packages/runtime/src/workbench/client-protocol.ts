import type { PluginNodeAddress } from '@pluxel/core'
import type {
	WorkbenchDeclarationIdentity,
	WorkbenchOpenableIdentity,
	WorkbenchContentIdentity,
} from '@pluxel/core/federation'
import type { WorkbenchContentPlan } from '@pluxel/core/internal'
import type { RpcTarget } from '../capnweb'
import type { ConfigPresentationFieldV1, RuntimeJsonObject } from '../web/protocol'
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
	descriptor: Exclude<WorkbenchOpenableIdentity, WorkbenchContentIdentity>
	target: WorkbenchLayoutTarget
	renderer: PluginNodeAddress
	definitionRevisions: Readonly<{
		target: number
		renderer: number
	}>
	placement: WorkbenchPlacement
	federatedViewRef: WorkbenchFederatedViewRef
}>

export type WorkbenchContentRef = Readonly<{
	profile: 1
	digest: string
	descriptor: WorkbenchContentIdentity
}>

export type WorkbenchContentLayoutEntry = Readonly<{
	descriptor: WorkbenchContentIdentity
	target: WorkbenchLayoutTarget
	definitionRevisions: Readonly<{
		target: number
	}>
	placement: WorkbenchPlacement
	contentRef: WorkbenchContentRef
}>

export type WorkbenchLayoutEntry = WorkbenchFederatedLayoutEntry | WorkbenchContentLayoutEntry

export type WorkbenchLayout = Readonly<{
	profile: 1
	revision: number
	target: WorkbenchLayoutTarget | null
	entries: readonly WorkbenchLayoutEntry[]
}>

export type WorkbenchLayoutInput = Readonly<{
	target: PluginNodeAddress | null
}>

export type WorkbenchOpenEntryInput = Readonly<{
	layoutRevision: number
	target: PluginNodeAddress
	descriptor: WorkbenchOpenableIdentity
	location?: string
}>

export type WorkbenchOpenEntryFailureCode =
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

export type WorkbenchContentDataPresentation = Readonly<{
	kind: 'data'
	key: string
	display: 'inline' | 'block'
	field: ConfigPresentationFieldV1
}>

export type WorkbenchContentActionPresentation = Readonly<{
	kind: 'action'
	key: string
	label: string
	confirm?: string
}> &
	(
		| Readonly<{ input: 'none'; fields?: never }>
		| Readonly<{
				input: 'dialog' | 'embedded'
				fields: readonly ConfigPresentationFieldV1[]
		  }>
	)

export type WorkbenchContentPresentation = Readonly<{
	slots: readonly (WorkbenchContentDataPresentation | WorkbenchContentActionPresentation)[]
}>

export type WorkbenchContentValidationIssue = Readonly<{
	path: readonly (string | number)[]
	message: string
}>

export type WorkbenchContentDataOutcome =
	| Readonly<{ sequence: number; ok: true; data: RuntimeJsonObject }>
	| Readonly<{ sequence: number; ok: false; code: 'load_failed' }>

export type WorkbenchContentLoadOutcome =
	| WorkbenchContentDataOutcome
	| Readonly<{ ok: false; code: 'busy' }>

export type WorkbenchContentActionOutcome =
	| Readonly<{ ok: true; message?: string }>
	| Readonly<{ ok: false; code: 'rejected'; message: string }>
	| Readonly<{
			ok: false
			code: 'validation_failed'
			issues: readonly WorkbenchContentValidationIssue[]
	  }>
	| Readonly<{
			ok: false
			code: 'busy' | 'unknown_action' | 'invalid_input' | 'action_failed'
	  }>

export type WorkbenchContentRunOutcome = Readonly<{
	action: WorkbenchContentActionOutcome
	data: WorkbenchContentDataOutcome | null
}>

export type WorkbenchContentObserver = (
	outcome: WorkbenchContentDataOutcome,
) => void | Promise<void>

export interface WorkbenchContentRoot extends RpcTarget {
	subscribe(observer: WorkbenchContentObserver): Promise<WorkbenchContentDataOutcome>
	load(): Promise<WorkbenchContentLoadOutcome>
	run(actionKey: string, rawInput?: unknown): Promise<WorkbenchContentRunOutcome>
}

type WorkbenchOpenedContentBase = Readonly<{
	kind: 'content'
	params: Readonly<Record<string, string>>
	contentRef: WorkbenchContentRef
	plan: WorkbenchContentPlan
}>

export type WorkbenchOpenedStaticContent = WorkbenchOpenedContentBase & Readonly<{ mode: 'static' }>

export type WorkbenchOpenedInteractiveContent = WorkbenchOpenedContentBase &
	Readonly<{
		mode: 'interactive'
		presentation: WorkbenchContentPresentation
		root: WorkbenchContentRoot
	}>

export type WorkbenchOpenedContent =
	| WorkbenchOpenedStaticContent
	| WorkbenchOpenedInteractiveContent

export type WorkbenchOpenedEntry =
	| WorkbenchOpenedLocalView
	| WorkbenchOpenedAttachment
	| WorkbenchOpenedContent

export type WorkbenchOpenEntryResult =
	| Readonly<{ ok: true; value: WorkbenchOpenedEntry }>
	| Readonly<{ ok: false; code: WorkbenchOpenEntryFailureCode }>

export interface WorkbenchSessionApi extends RpcTarget {
	layout(input: WorkbenchLayoutInput): WorkbenchLayout
	openEntry(input: WorkbenchOpenEntryInput): Promise<WorkbenchOpenEntryResult>
}
