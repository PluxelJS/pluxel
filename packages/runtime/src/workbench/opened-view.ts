import type { RpcStub, RpcTarget } from '../capnweb'
import type { WorkbenchFederatedViewRef } from './client-protocol'

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

export type WorkbenchOpenedClientValue = OpenedLocalValue | OpenedAttachmentValue

/** @internal Shared only by the public client constructor and generated Bridge ABI. */
export type WorkbenchOpenedState = {
	active: boolean
	result: DisposableValue
	value: WorkbenchOpenedClientValue
}

/**
 * Owns exactly one successful Cap'n Web `openView()` result.
 *
 * Consumers must dispose the handle once, after the MF Bridge has been destroyed. Member stubs
 * are deliberately not exposed as separately-owned handles.
 */
export class WorkbenchOpenedViewHandle implements Disposable {
	readonly kind: WorkbenchOpenedClientValue['kind']
	readonly params: Readonly<Record<string, string>>
	readonly federatedViewRef: WorkbenchFederatedViewRef
	readonly [OPENED]: WorkbenchOpenedState

	private constructor(state: WorkbenchOpenedState) {
		this.kind = state.value.kind
		this.params = state.value.params
		this.federatedViewRef = state.value.federatedViewRef
		this[OPENED] = state
		Object.freeze(this)
	}

	static [CREATE](state: WorkbenchOpenedState): WorkbenchOpenedViewHandle {
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

export function createWorkbenchOpenedViewHandle(
	state: WorkbenchOpenedState,
): WorkbenchOpenedViewHandle {
	return WorkbenchOpenedViewHandle[CREATE](state)
}

export function readWorkbenchOpenedViewHandle(
	handle: WorkbenchOpenedViewHandle,
): WorkbenchOpenedClientValue {
	if (!(handle instanceof WorkbenchOpenedViewHandle)) {
		throw new TypeError('[workbench/client] invalid opened View handle')
	}
	const state = handle[OPENED]
	if (!state.active) throw new Error('[workbench/client] opened View handle is closed')
	return state.value
}
