import type {
	WorkbenchContentActionOutcome,
	WorkbenchContentDataOutcome,
	WorkbenchContentRunOutcome,
	WorkbenchOpenedContentHandle,
} from '@pluxel/runtime/workbench/client'
import type { RuntimeJsonObject } from '@pluxel/runtime/web'

export type WorkbenchContentDataState = Readonly<{
	status: 'loading' | 'ready' | 'error'
	data: RuntimeJsonObject | null
	stale: boolean
	refreshing: boolean
	message: string | null
}>

const INITIAL_STATE: WorkbenchContentDataState = Object.freeze({
	status: 'loading',
	data: null,
	stale: false,
	refreshing: false,
	message: null,
})

/**
 * Browser-local state for one interactive Content handle.
 *
 * Cap'n Web remains the transport and subscription lifecycle. This class only gives React a
 * stable, ordered view of the outcomes arriving through that capability.
 */
export class WorkbenchContentController implements Disposable {
	readonly #handle: WorkbenchOpenedContentHandle
	readonly #hasData: boolean
	readonly #listeners = new Set<() => void>()
	#state = INITIAL_STATE
	#latestSequence = 0
	#active = true
	#started = false
	#refreshing: Promise<void> | null = null

	constructor(handle: WorkbenchOpenedContentHandle) {
		if (handle.mode !== 'interactive') {
			throw new TypeError('[workbench-app] interactive Content handle required')
		}
		this.#handle = handle
		this.#hasData = handle.presentation?.slots.some((slot) => slot.kind === 'data') ?? false
	}

	getSnapshot = (): WorkbenchContentDataState => this.#state

	subscribe = (listener: () => void): (() => void) => {
		if (!this.#active) return () => undefined
		this.#listeners.add(listener)
		return () => this.#listeners.delete(listener)
	}

	start(): void {
		if (!this.#active || this.#started) return
		this.#started = true
		if (!this.#hasData) return
		void this.#handle
			.subscribe((outcome) => this.#accept(outcome))
			.then(
				(outcome) => this.#accept(outcome),
				() => this.#fail('无法加载 Content 数据，请重试。'),
			)
	}

	retry = (): Promise<void> => {
		if (!this.#active || !this.#hasData) return Promise.resolve()
		if (this.#refreshing !== null) return this.#refreshing
		this.#replace({ ...this.#state, refreshing: true })
		const refreshing = this.#handle.load().then(
			(outcome): undefined => {
				if ('sequence' in outcome) this.#accept(outcome)
				return undefined
			},
			(): undefined => {
				this.#fail('无法刷新 Content 数据，请重试。')
				return undefined
			},
		)
		const finished = refreshing.finally(() => {
			if (this.#refreshing !== finished) return
			this.#refreshing = null
			if (this.#active && this.#state.refreshing) {
				this.#replace({ ...this.#state, refreshing: false })
			}
		})
		this.#refreshing = finished
		return finished
	}

	async run(actionKey: string, rawInput?: unknown): Promise<WorkbenchContentActionOutcome> {
		const outcome: WorkbenchContentRunOutcome =
			rawInput === undefined
				? await this.#handle.run(actionKey)
				: await this.#handle.run(actionKey, rawInput)
		if (outcome.data) this.#accept(outcome.data)
		return outcome.action
	}

	[Symbol.dispose](): void {
		if (!this.#active) return
		this.#active = false
		this.#listeners.clear()
	}

	#accept(outcome: WorkbenchContentDataOutcome): void {
		if (!this.#active || outcome.sequence <= this.#latestSequence) return
		this.#latestSequence = outcome.sequence
		if (outcome.ok) {
			this.#replace({
				status: 'ready',
				data: outcome.data,
				stale: false,
				refreshing: this.#state.refreshing,
				message: null,
			})
			return
		}
		this.#fail('Content 数据暂时不可用，请重试。')
	}

	#fail(message: string): void {
		if (!this.#active) return
		if (this.#state.data) {
			this.#replace({
				status: 'ready',
				data: this.#state.data,
				stale: true,
				refreshing: this.#state.refreshing,
				message,
			})
			return
		}
		this.#replace({
			status: 'error',
			data: null,
			stale: false,
			refreshing: this.#state.refreshing,
			message,
		})
	}

	#replace(state: WorkbenchContentDataState): void {
		if (!this.#active) return
		this.#state = Object.freeze(state)
		for (const listener of this.#listeners) listener()
	}
}
