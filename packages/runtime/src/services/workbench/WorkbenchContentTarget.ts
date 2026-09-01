import type { ContextLogger } from '@pluxel/core'
import { RpcTarget, type RpcStub } from '../../capnweb'
import { parseRuntimePortableData } from '../../web/validation'
import type { RuntimeJsonObject } from '../../web/protocol'
import type {
	WorkbenchContentActionOutcome,
	WorkbenchContentDataOutcome,
	WorkbenchContentLoadOutcome,
	WorkbenchContentObserver,
	WorkbenchContentRoot,
	WorkbenchContentRunOutcome,
	WorkbenchContentValidationIssue,
} from '../../workbench/client-protocol'
import type { WorkbenchContentSchema } from '../../workbench/definition'
import type {
	WorkbenchContentContract,
	WorkbenchContentRuntimeBinding,
} from './WorkbenchContentPresentation'

const OBSERVER_DEADLINE_MS = 10_000
const MAX_ACTION_MESSAGE = 1_024
const MAX_VALIDATION_ISSUES = 64
const MAX_VALIDATION_PATH = 32

type PendingBrowserRequest = {
	run(): Promise<unknown>
	closed(): unknown
	resolve(value: unknown): void
}

/** Framework-owned per-open Content root; Plugin authors only receive its stable dataChanged(). */
export class WorkbenchContentTarget extends RpcTarget implements WorkbenchContentRoot {
	readonly dataChanged = (): void => {
		if (!this.active || this.contract.data.size === 0) return
		this.dirty = true
		this.advance()
	}

	private binding?: WorkbenchContentRuntimeBinding
	private observer?: RpcStub<WorkbenchContentObserver>
	private sequence = 0
	private running: 'browser' | 'background' | null = null
	private runningBrowser?: PendingBrowserRequest
	private pendingBrowser?: PendingBrowserRequest
	private backgroundScheduled = false
	private dirty = false
	private subscribed = false
	private active = true

	constructor(
		private readonly contract: WorkbenchContentContract,
		private readonly logger: ContextLogger,
		private readonly onFatalClose?: (reason: unknown) => void,
	) {
		super()
	}

	attach(binding: WorkbenchContentRuntimeBinding): void {
		if (!this.active || this.binding) {
			throw new Error('[workbench] Content root cannot attach its binding')
		}
		this.binding = binding
	}

	async subscribe(
		observer: RpcStub<WorkbenchContentObserver>,
	): Promise<WorkbenchContentDataOutcome> {
		this.assertActive()
		if (this.contract.data.size === 0) {
			throw new TypeError('[workbench] action-only Content cannot subscribe')
		}
		if (this.subscribed) throw new TypeError('[workbench] Content observer was already subscribed')
		if (this.running || this.pendingBrowser) {
			throw new Error('[workbench] Content observer cannot subscribe during an operation')
		}
		if (!observer || typeof observer !== 'function' || typeof observer.dup !== 'function') {
			throw new TypeError('[workbench] Content observer must be an RPC callback')
		}
		this.observer = observer.dup()
		this.subscribed = true
		return await this.browserRequest<WorkbenchContentDataOutcome>(
			() => this.loadData(),
			() => this.failedData(),
			() => this.failedData(),
		)
	}

	async load(): Promise<WorkbenchContentLoadOutcome> {
		if (!this.canReadData()) return this.failedData()
		return await this.browserRequest<WorkbenchContentLoadOutcome>(
			() => this.loadData(),
			() => Object.freeze({ ok: false as const, code: 'busy' as const }),
			() => this.failedData(),
		)
	}

	async run(actionKey: string, rawInput?: unknown): Promise<WorkbenchContentRunOutcome> {
		if (!this.active || (this.contract.data.size > 0 && !this.subscribed)) {
			return runFailure('invalid_input')
		}
		return await this.browserRequest(
			() => this.runAction(actionKey, rawInput),
			() => runFailure('busy'),
			() => runFailure('action_failed'),
		)
	}

	[Symbol.dispose](): void {
		if (!this.active) return
		this.active = false
		this.dirty = false
		this.backgroundScheduled = false
		this.binding = undefined
		this.observer?.[Symbol.dispose]()
		this.observer = undefined
		const running = this.runningBrowser
		this.runningBrowser = undefined
		const pending = this.pendingBrowser
		this.pendingBrowser = undefined
		if (running) running.resolve(running.closed())
		if (pending) pending.resolve(pending.closed())
	}

	private async runAction(
		actionKey: string,
		rawInput: unknown,
	): Promise<WorkbenchContentRunOutcome> {
		const action =
			typeof actionKey === 'string' && actionKey.length <= 128
				? this.contract.actions.get(actionKey)
				: undefined
		const handler = action ? this.binding?.actions?.get(actionKey) : undefined
		if (!action || !handler) return runFailure('unknown_action')

		let input: unknown
		if (action.schema === undefined) {
			if (rawInput !== undefined) return runFailure('invalid_input')
		} else {
			let portable: unknown
			try {
				portable = parseRuntimePortableData(rawInput, `Content action ${actionKey} input`)
			} catch {
				return runFailure('invalid_input')
			}
			if (!portable || typeof portable !== 'object' || Array.isArray(portable)) {
				return runFailure('invalid_input')
			}
			const parsed = await validateSchema(action.schema, portable)
			if (parsed.ok === false) {
				return Object.freeze({
					action: Object.freeze({
						ok: false as const,
						code: 'validation_failed' as const,
						issues: parsed.issues,
					}),
					data: null,
				})
			}
			input = parsed.value
		}

		let actionOutcome: WorkbenchContentActionOutcome
		try {
			actionOutcome = normalizeActionResult(
				await (action.schema === undefined ? handler() : handler(input)),
			)
		} catch (error) {
			this.logger.error('Workbench Content action failed', { error, action: actionKey })
			actionOutcome = Object.freeze({ ok: false, code: 'action_failed' })
		}

		const data = this.contract.data.size === 0 ? null : await this.loadData()
		return Object.freeze({ action: actionOutcome, data })
	}

	private async loadData(): Promise<WorkbenchContentDataOutcome> {
		const sequence = ++this.sequence
		this.dirty = false
		try {
			const raw = await this.binding?.load?.()
			const record = plainRecord(raw, 'Content load result')
			const expectedKeys = [...this.contract.data.keys()].sort()
			const actualKeys = Object.keys(record).sort()
			if (!sameStrings(expectedKeys, actualKeys)) {
				throw new TypeError('Content load result must exactly match its data slots')
			}
			const output: Record<string, unknown> = Object.create(null)
			for (const key of expectedKeys) {
				const schema = this.contract.data.get(key)!
				const parsed = await validateSchema(schema, record[key])
				if (!parsed.ok) throw new TypeError(`Content data ${key} failed its display schema`)
				output[key] = parsed.value
			}
			const data = parseRuntimePortableData(output, 'Content load result')
			if (!data || typeof data !== 'object' || Array.isArray(data)) {
				throw new TypeError('Content load result must be a portable object')
			}
			return Object.freeze({
				sequence,
				ok: true as const,
				data: data as RuntimeJsonObject,
			})
		} catch (error) {
			if (this.active) this.logger.error('Workbench Content load failed', { error })
			return Object.freeze({ sequence, ok: false as const, code: 'load_failed' as const })
		}
	}

	private failedData(): WorkbenchContentDataOutcome {
		return Object.freeze({
			sequence: ++this.sequence,
			ok: false as const,
			code: 'load_failed' as const,
		})
	}

	private canReadData(): boolean {
		return this.active && this.contract.data.size > 0 && this.subscribed
	}

	private assertActive(): void {
		if (!this.active) throw new Error('[workbench] Content root is closed')
		if (!this.binding) throw new Error('[workbench] Content root is not active')
	}

	private browserRequest<T>(run: () => Promise<T>, busy: () => T, closed: () => T): Promise<T> {
		if (!this.active) return Promise.resolve(closed())
		if (this.running === 'browser' || this.pendingBrowser) return Promise.resolve(busy())
		return new Promise<T>((resolve) => {
			const request: PendingBrowserRequest = {
				run,
				closed,
				resolve: (value) => resolve(value as T),
			}
			if (this.running === 'background') this.pendingBrowser = request
			else this.startBrowser(request)
		})
	}

	private startBrowser(request: PendingBrowserRequest): void {
		this.running = 'browser'
		this.runningBrowser = request
		void request
			.run()
			.then(request.resolve, () => request.resolve(request.closed()))
			.finally(() => {
				if (this.runningBrowser === request) this.runningBrowser = undefined
				this.running = null
				this.advance()
			})
	}

	private advance(): void {
		if (!this.active || this.running) return
		const request = this.pendingBrowser
		if (request) {
			this.pendingBrowser = undefined
			this.startBrowser(request)
			return
		}
		if (
			!this.dirty ||
			!this.subscribed ||
			!this.observer ||
			!this.binding ||
			this.backgroundScheduled
		) {
			return
		}
		this.backgroundScheduled = true
		queueMicrotask(() => {
			this.backgroundScheduled = false
			if (!this.active || this.running) {
				this.advance()
				return
			}
			if (!this.dirty || !this.observer || !this.binding) return
			this.running = 'background'
			void this.pushLatest().finally(() => {
				this.running = null
				this.advance()
			})
		})
	}

	private async pushLatest(): Promise<void> {
		const outcome = await this.loadData()
		if (!this.active || !this.observer) return
		let result: ReturnType<RpcStub<WorkbenchContentObserver>> | undefined
		try {
			result = this.observer(outcome)
			await waitForObserver(result)
		} catch (error) {
			this.closeAfterObserverFailure(error)
		} finally {
			result?.[Symbol.dispose]()
		}
	}

	private closeAfterObserverFailure(reason: unknown): void {
		try {
			this.onFatalClose?.(reason)
		} finally {
			if (this.active) this[Symbol.dispose]()
		}
	}
}

async function validateSchema(
	schema: WorkbenchContentSchema,
	input: unknown,
): Promise<
	| Readonly<{ ok: true; value: unknown }>
	| Readonly<{ ok: false; issues: readonly WorkbenchContentValidationIssue[] }>
> {
	try {
		const result = await schema['~standard'].validate(input)
		if ('issues' in result && result.issues) {
			return Object.freeze({
				ok: false as const,
				issues: Object.freeze(result.issues.slice(0, MAX_VALIDATION_ISSUES).map(sanitizeIssue)),
			})
		}
		if ('value' in result) return Object.freeze({ ok: true as const, value: result.value })
		return Object.freeze({ ok: true as const, value: undefined })
	} catch {
		return Object.freeze({
			ok: false as const,
			issues: Object.freeze([
				Object.freeze({ path: Object.freeze([]), message: 'Input validation failed' }),
			]),
		})
	}
}

function sanitizeIssue(issue: {
	message: string
	path?: readonly (PropertyKey | Readonly<{ key: PropertyKey }>)[]
}): WorkbenchContentValidationIssue {
	const path: Array<string | number> = []
	for (const item of issue.path?.slice(0, MAX_VALIDATION_PATH) ?? []) {
		const raw = item && typeof item === 'object' ? item.key : item
		if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0) path.push(raw)
		else if (typeof raw === 'string' && raw) path.push(raw.slice(0, 128))
		else if (typeof raw === 'symbol') path.push((raw.description ?? raw.toString()).slice(0, 128))
	}
	return Object.freeze({
		path: Object.freeze(path),
		message:
			typeof issue.message === 'string' && issue.message
				? issue.message.slice(0, MAX_ACTION_MESSAGE)
				: 'Invalid input',
	})
}

function normalizeActionResult(input: unknown): WorkbenchContentActionOutcome {
	if (input === undefined) return Object.freeze({ ok: true as const })
	const record = plainRecord(input, 'Content action result')
	const keys = Object.keys(record).sort()
	if (!sameStrings(keys, ['message', 'ok'])) {
		throw new TypeError('Content action result has unsupported or missing fields')
	}
	if (
		typeof record.message !== 'string' ||
		!record.message ||
		record.message.length > MAX_ACTION_MESSAGE
	) {
		throw new TypeError('Content action result message is invalid')
	}
	if (record.ok === true) {
		return Object.freeze({ ok: true as const, message: record.message })
	}
	if (record.ok === false) {
		return Object.freeze({ ok: false as const, code: 'rejected' as const, message: record.message })
	}
	throw new TypeError('Content action result ok is invalid')
}

function runFailure(
	code: 'busy' | 'unknown_action' | 'invalid_input' | 'action_failed',
): WorkbenchContentRunOutcome {
	return Object.freeze({ action: Object.freeze({ ok: false as const, code }), data: null })
}

function plainRecord(input: unknown, label: string): Record<string, unknown> {
	if (!input || typeof input !== 'object' || Array.isArray(input)) {
		throw new TypeError(`${label} must be a plain record`)
	}
	const prototype = Object.getPrototypeOf(input)
	if (prototype !== Object.prototype && prototype !== null) {
		throw new TypeError(`${label} must be a plain record`)
	}
	return input as Record<string, unknown>
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index])
}

async function waitForObserver(result: PromiseLike<unknown>): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined
	try {
		await Promise.race([
			result,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(
					() => reject(new Error('Workbench Content observer timed out')),
					OBSERVER_DEADLINE_MS,
				)
				timer.unref?.()
			}),
		])
	} finally {
		if (timer !== undefined) clearTimeout(timer)
	}
}
