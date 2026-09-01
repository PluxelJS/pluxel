import { parsePluginNodeAddress } from '@pluxel/core'
import { parseWorkbenchOpenableIdentity } from '@pluxel/core/federation'
import { RpcTarget } from '../../capnweb'
import type { WorkbenchPrincipal } from '../../workbench/definition'
import type {
	WorkbenchLayoutInput,
	WorkbenchOpenEntryInput,
	WorkbenchSessionApi,
} from '../../workbench/client-protocol'
import { OpenedEntryLease, WorkbenchRegistry } from './WorkbenchRegistry'

const EXPIRE = Symbol('pluxel.workbench.session.expire')
const SIGNAL = Symbol('pluxel.workbench.session.signal')

export class WorkbenchSessionTarget extends RpcTarget implements WorkbenchSessionApi {
	readonly #controller = new AbortController()
	readonly #opened = new Set<OpenedEntryLease>()
	#active = true

	constructor(
		private readonly registry: WorkbenchRegistry,
		private readonly principal: WorkbenchPrincipal,
		private readonly onDispose: () => void,
	) {
		super()
	}

	layout(input: WorkbenchLayoutInput) {
		this.#assertActive()
		return this.registry.getLayout(parseLayoutInput(input).target)
	}

	async openEntry(input: WorkbenchOpenEntryInput) {
		this.#assertActive()
		return await this.registry.openEntry(
			this.principal,
			this.#controller.signal,
			parseOpenEntryInput(input),
			this.#opened,
		)
	}

	[EXPIRE](cause: unknown): void {
		if (!this.#active) return
		this.#active = false
		this.#controller.abort(cause)
		const openedEntries = [...this.#opened]
		for (const opened of openedEntries) opened.close()
		this.#opened.clear()
		this.onDispose()
	}

	[SIGNAL](): AbortSignal {
		return this.#controller.signal
	}

	[Symbol.dispose](): void {
		this[EXPIRE](new Error('Workbench session closed'))
	}

	#assertActive(): void {
		if (!this.#active) throw this.#controller.signal.reason
	}
}

export function expireWorkbenchSession(target: WorkbenchSessionTarget, cause: unknown): void {
	target[EXPIRE](cause)
}

export function workbenchSessionSignal(target: WorkbenchSessionTarget): AbortSignal {
	return target[SIGNAL]()
}

function parseLayoutInput(input: unknown): WorkbenchLayoutInput {
	const record = readExactRecord(input, 'layout input', ['target'])
	return Object.freeze({
		target: record.target === null ? null : parsePluginNodeAddress(record.target),
	})
}

function parseOpenEntryInput(input: unknown): WorkbenchOpenEntryInput {
	const record = readExactRecord(input, 'openEntry input', [
		'layoutRevision',
		'target',
		'descriptor',
		'location',
	])
	if (!Number.isSafeInteger(record.layoutRevision) || (record.layoutRevision as number) < 0) {
		throw new TypeError('[workbench] openEntry.layoutRevision must be a non-negative safe integer')
	}
	if (
		record.location !== undefined &&
		(typeof record.location !== 'string' || record.location.length > 4096)
	) {
		throw new TypeError('[workbench] openEntry.location must be a bounded string')
	}
	return Object.freeze({
		layoutRevision: record.layoutRevision as number,
		target: parsePluginNodeAddress(record.target),
		descriptor: parseWorkbenchOpenableIdentity(record.descriptor),
		...(record.location === undefined ? {} : { location: record.location as string }),
	})
}

function readExactRecord(
	input: unknown,
	label: string,
	keys: readonly string[],
): Record<string, unknown> {
	if (!input || typeof input !== 'object' || Array.isArray(input)) {
		throw new TypeError(`[workbench] ${label} must be an object`)
	}
	const record = input as Record<string, unknown>
	const actual = Object.keys(record).sort()
	const allowed = new Set(keys)
	if (actual.some((key) => !allowed.has(key))) {
		throw new TypeError(`[workbench] ${label} includes unsupported fields`)
	}
	for (const key of keys) {
		if (key === 'location') continue
		if (!Object.hasOwn(record, key)) throw new TypeError(`[workbench] ${label}.${key} is required`)
	}
	return record
}
