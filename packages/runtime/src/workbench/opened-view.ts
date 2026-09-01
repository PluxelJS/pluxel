import type { RpcStub, RpcTarget } from '../capnweb'
import type { WorkbenchStandardPagePlanV1 } from '@pluxel/core/internal'
import type { WorkbenchFederatedViewRef, WorkbenchStandardPageRef } from './client-protocol'

const OPENED = Symbol('pluxel.workbench.opened-view')
const CREATE = Symbol('pluxel.workbench.create-opened-view')

type DisposableValue = Readonly<{ [Symbol.dispose](): void }>

type OpenedLocalValue = Readonly<{
	kind: 'local'
	api: RpcStub<RpcTarget>
	params: Readonly<Record<string, string>>
	federatedViewRef: WorkbenchFederatedViewRef
}>

type OpenedAttachmentValue = Readonly<{
	kind: 'attachment'
	provider: RpcStub<RpcTarget>
	consumer?: RpcStub<RpcTarget>
	params: Readonly<Record<string, string>>
	federatedViewRef: WorkbenchFederatedViewRef
}>

type OpenedStandardPageValue = Readonly<{
	kind: 'page'
	params: Readonly<Record<string, string>>
	standardPageRef: WorkbenchStandardPageRef
	plan: WorkbenchStandardPagePlanV1
}>

export type WorkbenchOpenedFederatedClientValue = OpenedLocalValue | OpenedAttachmentValue
export type WorkbenchOpenedClientValue =
	| WorkbenchOpenedFederatedClientValue
	| OpenedStandardPageValue

/** @internal Shared only by the public client constructor and generated Bridge ABI. */
export type WorkbenchOpenedState = {
	active: boolean
	result: DisposableValue
	value: WorkbenchOpenedClientValue
}

type WorkbenchOpenedFederatedState = WorkbenchOpenedState & {
	value: WorkbenchOpenedFederatedClientValue
}

type WorkbenchOpenedPageState = WorkbenchOpenedState & {
	value: OpenedStandardPageValue
}

/**
 * Owns exactly one successful Cap'n Web `openView()` result.
 *
 * Consumers must dispose the handle once, after the MF Bridge has been destroyed. Member stubs
 * are deliberately not exposed as separately-owned handles.
 */
export class WorkbenchOpenedViewHandle implements Disposable {
	readonly kind: WorkbenchOpenedFederatedClientValue['kind']
	readonly params: Readonly<Record<string, string>>
	readonly federatedViewRef: WorkbenchFederatedViewRef
	readonly [OPENED]: WorkbenchOpenedFederatedState

	private constructor(state: WorkbenchOpenedFederatedState) {
		this.kind = state.value.kind
		this.params = state.value.params
		this.federatedViewRef = state.value.federatedViewRef
		this[OPENED] = state
		Object.freeze(this)
	}

	static [CREATE](state: WorkbenchOpenedFederatedState): WorkbenchOpenedViewHandle {
		return new WorkbenchOpenedViewHandle(state)
	}

	get active(): boolean {
		return this[OPENED].active
	}

	[Symbol.dispose](): void {
		const state = this[OPENED]
		if (!state.active) return
		state.active = false
		state.result[Symbol.dispose]()
	}
}

/** Owns one capability-free Standard Page `openView()` result. */
export class WorkbenchOpenedPageHandle implements Disposable {
	readonly kind = 'page' as const
	readonly params: Readonly<Record<string, string>>
	readonly standardPageRef: WorkbenchStandardPageRef
	readonly plan: WorkbenchStandardPagePlanV1
	readonly [OPENED]: WorkbenchOpenedPageState

	private constructor(state: WorkbenchOpenedPageState) {
		this.params = state.value.params
		this.standardPageRef = state.value.standardPageRef
		this.plan = state.value.plan
		this[OPENED] = state
		Object.freeze(this)
	}

	static [CREATE](state: WorkbenchOpenedPageState): WorkbenchOpenedPageHandle {
		return new WorkbenchOpenedPageHandle(state)
	}

	get active(): boolean {
		return this[OPENED].active
	}

	[Symbol.dispose](): void {
		const state = this[OPENED]
		if (!state.active) return
		state.active = false
		state.result[Symbol.dispose]()
	}
}

export function createWorkbenchOpenedViewHandle(
	state: WorkbenchOpenedFederatedState,
): WorkbenchOpenedViewHandle {
	return WorkbenchOpenedViewHandle[CREATE](state)
}

export function createWorkbenchOpenedPageHandle(
	state: WorkbenchOpenedPageState,
): WorkbenchOpenedPageHandle {
	return WorkbenchOpenedPageHandle[CREATE](state)
}

export function readWorkbenchOpenedViewHandle(
	handle: WorkbenchOpenedViewHandle,
): WorkbenchOpenedFederatedClientValue {
	if (!(handle instanceof WorkbenchOpenedViewHandle)) {
		throw new TypeError('[workbench/client] invalid opened View handle')
	}
	const state = handle[OPENED]
	if (!state.active) throw new Error('[workbench/client] opened View handle is closed')
	return state.value
}
