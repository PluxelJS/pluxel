import type { RpcStub, RpcTarget } from '../capnweb'
import type { WorkbenchContentPlan } from '@pluxel/core/internal'
import type {
	WorkbenchContentDataOutcome,
	WorkbenchContentLoadOutcome,
	WorkbenchContentObserver,
	WorkbenchContentPresentation,
	WorkbenchContentRef,
	WorkbenchContentRoot,
	WorkbenchContentRunOutcome,
	WorkbenchFederatedViewRef,
} from './client-protocol'
import {
	parseWorkbenchContentDataOutcome,
	parseWorkbenchContentLoadOutcome,
	parseWorkbenchContentRunOutcome,
} from './client-validation'

const OPENED = Symbol('pluxel.workbench.opened-entry')
const CREATE = Symbol('pluxel.workbench.create-opened-entry')

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

type OpenedContentBase = Readonly<{
	kind: 'content'
	params: Readonly<Record<string, string>>
	contentRef: WorkbenchContentRef
	plan: WorkbenchContentPlan
}>

type OpenedContentValue = OpenedContentBase &
	(
		| Readonly<{ mode: 'static' }>
		| Readonly<{
				mode: 'interactive'
				presentation: WorkbenchContentPresentation
				root: RpcStub<WorkbenchContentRoot>
		  }>
	)

export type WorkbenchOpenedFederatedClientValue = OpenedLocalValue | OpenedAttachmentValue
export type WorkbenchOpenedClientValue = WorkbenchOpenedFederatedClientValue | OpenedContentValue

/** @internal Shared only by the public client constructor and generated Bridge ABI. */
export type WorkbenchOpenedState = {
	active: boolean
	result: DisposableValue
	value: WorkbenchOpenedClientValue
}

type WorkbenchOpenedFederatedState = WorkbenchOpenedState & {
	value: WorkbenchOpenedFederatedClientValue
}

type WorkbenchOpenedContentState = WorkbenchOpenedState & {
	value: OpenedContentValue
}

/**
 * Owns exactly one successful Cap'n Web `openEntry()` result.
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

/** Owns one Workbench Content `openEntry()` result and encapsulates its interactive capability. */
export class WorkbenchOpenedContentHandle implements Disposable {
	readonly kind = 'content' as const
	readonly params: Readonly<Record<string, string>>
	readonly contentRef: WorkbenchContentRef
	readonly plan: WorkbenchContentPlan
	readonly mode: OpenedContentValue['mode']
	readonly presentation: WorkbenchContentPresentation | null
	readonly [OPENED]: WorkbenchOpenedContentState

	private constructor(state: WorkbenchOpenedContentState) {
		this.params = state.value.params
		this.contentRef = state.value.contentRef
		this.plan = state.value.plan
		this.mode = state.value.mode
		this.presentation = state.value.mode === 'interactive' ? state.value.presentation : null
		this[OPENED] = state
		Object.freeze(this)
	}

	static [CREATE](state: WorkbenchOpenedContentState): WorkbenchOpenedContentHandle {
		return new WorkbenchOpenedContentHandle(state)
	}

	get active(): boolean {
		return this[OPENED].active
	}

	async subscribe(observer: WorkbenchContentObserver): Promise<WorkbenchContentDataOutcome> {
		const root = this.#interactiveRoot()
		const outcome = await root.subscribe((value) =>
			observer(parseWorkbenchContentDataOutcome(value)),
		)
		return parseWorkbenchContentDataOutcome(outcome)
	}

	async load(): Promise<WorkbenchContentLoadOutcome> {
		return parseWorkbenchContentLoadOutcome(await this.#interactiveRoot().load())
	}

	async run(actionKey: string, rawInput?: unknown): Promise<WorkbenchContentRunOutcome> {
		return parseWorkbenchContentRunOutcome(await this.#interactiveRoot().run(actionKey, rawInput))
	}

	[Symbol.dispose](): void {
		const state = this[OPENED]
		if (!state.active) return
		state.active = false
		state.result[Symbol.dispose]()
	}

	#interactiveRoot(): RpcStub<WorkbenchContentRoot> {
		const state = this[OPENED]
		if (!state.active) throw new Error('[workbench/client] opened Content handle is closed')
		if (state.value.mode !== 'interactive') {
			throw new Error('[workbench/client] static Content has no interaction root')
		}
		return state.value.root
	}
}

export function createWorkbenchOpenedViewHandle(
	state: WorkbenchOpenedFederatedState,
): WorkbenchOpenedViewHandle {
	return WorkbenchOpenedViewHandle[CREATE](state)
}

export function createWorkbenchOpenedContentHandle(
	state: WorkbenchOpenedContentState,
): WorkbenchOpenedContentHandle {
	return WorkbenchOpenedContentHandle[CREATE](state)
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
