import {
	ATTR_OPERATION_NAME,
	ATTR_OPERATION_RESULT,
	ATTR_PLUGIN_ID,
	EXPORT_FAILURE_LOG_INTERVAL_MS,
	MAX_OPERATION_NAME_BYTES,
	MAX_OPERATIONS,
	MAX_OPERATIONS_PER_PLUGIN,
} from './constants.ts'
import type {
	CapacityLimit,
	MetricsRecorder,
	OperationMetric,
	OperationResult,
} from './recorder.ts'

const KEY_SEPARATOR = String.fromCharCode(0)

type EffectGuard = { readonly active: boolean }

export type MetricsOwnerContext = Readonly<{
	pluginInfo: Readonly<{ id: string }>
	effects: Readonly<{
		defer(cleanup: () => void, meta?: Readonly<{ tag?: string }>): EffectGuard
	}>
}>

export type MetricsRuntimeLogger = Readonly<{
	warn(message: string, properties?: Readonly<Record<string, unknown>>): void
}>

type OperationSlot = OperationMetric & {
	readonly key: string
	activeOwners: number
	retiring: boolean
}

type OwnerState = {
	active: boolean
	readonly context: MetricsOwnerContext
	readonly operations: Map<string, OperationSlot>
}

function utf8Bytes(value: string): number {
	return new TextEncoder().encode(value).byteLength
}

function validateOperation(operation: string): string {
	if (typeof operation !== 'string' || operation.length === 0 || operation.trim() !== operation) {
		throw new TypeError('Metrics operation must be a non-empty string without outer whitespace')
	}
	for (let index = 0; index < operation.length; index += 1) {
		const code = operation.charCodeAt(index)
		if (code <= 31 || (code >= 127 && code <= 159)) {
			throw new TypeError('Metrics operation must not contain control characters')
		}
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = operation.charCodeAt(index + 1)
			if (!Number.isFinite(next) || next < 0xdc00 || next > 0xdfff) {
				throw new TypeError('Metrics operation must not contain unpaired surrogates')
			}
			index += 1
			continue
		}
		if (code >= 0xdc00 && code <= 0xdfff) {
			throw new TypeError('Metrics operation must not contain unpaired surrogates')
		}
	}
	if (utf8Bytes(operation) > MAX_OPERATION_NAME_BYTES) {
		throw new TypeError('Metrics operation exceeds 128 UTF-8 bytes')
	}
	return operation
}

function errorTypeOf(error: unknown): string {
	try {
		if (error && typeof error === 'object') {
			const name = (error as { name?: unknown }).name
			if (typeof name === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(name)) return name
		}
	} catch {
		return 'unknown'
	}
	return error === null ? 'null' : typeof error
}

function isPromiseLike<T>(value: unknown): value is PromiseLike<T> {
	if (value === null) return false
	const kind = typeof value
	if (kind !== 'object' && kind !== 'function') return false
	return typeof (value as PromiseLike<T>).then === 'function'
}

export class OperationMetricsRuntime {
	private active = false
	private recorder: MetricsRecorder | undefined
	private readonly ownersByContext = new WeakMap<object, OwnerState>()
	private readonly owners = new Set<OwnerState>()
	private readonly slots = new Map<string, OperationSlot>()
	private readonly retiring = new Set<OperationSlot>()
	private readonly operationCountByPlugin = new Map<string, number>()
	private readonly capacityLogAt: Record<CapacityLimit, number> = {
		total: Number.NEGATIVE_INFINITY,
		per_plugin: Number.NEGATIVE_INFINITY,
	}
	private recordingFailureLogAt = Number.NEGATIVE_INFINITY

	constructor(private readonly logger: MetricsRuntimeLogger) {}

	start(recorder: MetricsRecorder): void {
		if (this.active || this.recorder) throw new Error('Metrics runtime is already started')
		this.recorder = recorder
		this.active = true
	}

	stop(): void {
		if (!this.active && !this.recorder) return
		this.active = false
		for (const owner of this.owners) this.releaseOwner(owner)
		this.owners.clear()
		this.slots.clear()
		this.retiring.clear()
		this.operationCountByPlugin.clear()
		this.recorder = undefined
	}

	onCollection(): void {
		if (!this.active || this.retiring.size === 0) return
		for (const slot of this.retiring) {
			if (!slot.retiring || slot.activeOwners > 0) continue
			this.retiring.delete(slot)
			this.slots.delete(slot.key)
			const next = (this.operationCountByPlugin.get(slot.pluginId) ?? 1) - 1
			if (next <= 0) this.operationCountByPlugin.delete(slot.pluginId)
			else this.operationCountByPlugin.set(slot.pluginId, next)
		}
	}

	measure<T>(
		context: MetricsOwnerContext,
		operationInput: string,
		run: () => T | PromiseLike<T>,
	): T | Promise<T> {
		const operation = validateOperation(operationInput)
		const recorder = this.recorder
		if (!this.active || !recorder) return this.runUnmeasured(run)

		const owner = this.ownerFor(context)
		if (!owner) return this.runUnmeasured(run)
		const slot = this.slotFor(owner, operation, recorder)
		if (!slot) return this.runUnmeasured(run)
		const startedAt = performance.now()

		let value: unknown
		try {
			value = run()
		} catch (error) {
			this.finish(owner, slot, recorder, 'error', startedAt)
			throw error
		}

		try {
			if (isPromiseLike<T>(value)) {
				return Promise.resolve(value).then(
					(result) => {
						this.finish(owner, slot, recorder, 'ok', startedAt)
						return result
					},
					(error) => {
						this.finish(owner, slot, recorder, 'error', startedAt)
						throw error
					},
				)
			}
		} catch (error) {
			this.finish(owner, slot, recorder, 'error', startedAt)
			throw error
		}

		this.finish(owner, slot, recorder, 'ok', startedAt)
		return value as T
	}

	private runUnmeasured<T>(run: () => T | PromiseLike<T>): T | Promise<T> {
		const value: unknown = run()
		return isPromiseLike<T>(value) ? Promise.resolve(value) : (value as T)
	}

	private ownerFor(context: MetricsOwnerContext): OwnerState | undefined {
		const key = context as object
		const existing = this.ownersByContext.get(key)
		if (existing?.active) return existing

		const owner: OwnerState = {
			active: true,
			context,
			operations: new Map(),
		}
		try {
			context.effects.defer(() => this.releaseOwner(owner), { tag: 'metrics-bindings' })
		} catch (error) {
			owner.active = false
			this.logRecordingFailure(error)
			return undefined
		}
		this.ownersByContext.set(key, owner)
		this.owners.add(owner)
		return owner
	}

	private slotFor(
		owner: OwnerState,
		operation: string,
		recorder: MetricsRecorder,
	): OperationSlot | undefined {
		const owned = owner.operations.get(operation)
		if (owned) return owned

		const pluginId = owner.context.pluginInfo.id
		const key = pluginId + KEY_SEPARATOR + operation
		let slot = this.slots.get(key)
		if (slot) {
			slot.activeOwners += 1
			slot.retiring = false
			this.retiring.delete(slot)
			owner.operations.set(operation, slot)
			return slot
		}

		const perPlugin = this.operationCountByPlugin.get(pluginId) ?? 0
		const limit: CapacityLimit | undefined =
			this.slots.size >= MAX_OPERATIONS
				? 'total'
				: perPlugin >= MAX_OPERATIONS_PER_PLUGIN
					? 'per_plugin'
					: undefined
		if (limit) {
			this.recordCapacityDrop(recorder, limit, pluginId)
			return undefined
		}

		const durationAttributes = Object.freeze({
			[ATTR_PLUGIN_ID]: pluginId,
			[ATTR_OPERATION_NAME]: operation,
		})
		slot = {
			key,
			pluginId,
			operation,
			activeOwners: 1,
			retiring: false,
			durationAttributes,
			okAttributes: Object.freeze({
				...durationAttributes,
				[ATTR_OPERATION_RESULT]: 'ok',
			}),
			errorAttributes: Object.freeze({
				...durationAttributes,
				[ATTR_OPERATION_RESULT]: 'error',
			}),
		}
		this.slots.set(key, slot)
		this.operationCountByPlugin.set(pluginId, perPlugin + 1)
		owner.operations.set(operation, slot)
		return slot
	}

	private finish(
		owner: OwnerState,
		slot: OperationSlot,
		recorder: MetricsRecorder,
		result: OperationResult,
		startedAt: number,
	): void {
		if (
			!this.active ||
			this.recorder !== recorder ||
			!owner.active ||
			owner.operations.get(slot.operation) !== slot
		) {
			return
		}
		const durationSeconds = Math.max(0, performance.now() - startedAt) / 1_000
		try {
			recorder.record(slot, result, durationSeconds)
		} catch (error) {
			this.logRecordingFailure(error)
		}
	}

	private releaseOwner(owner: OwnerState): void {
		if (!owner.active) return
		owner.active = false
		this.owners.delete(owner)
		for (const slot of owner.operations.values()) {
			slot.activeOwners -= 1
			if (slot.activeOwners <= 0) {
				slot.activeOwners = 0
				slot.retiring = true
				this.retiring.add(slot)
			}
		}
		owner.operations.clear()
	}

	private recordCapacityDrop(
		recorder: MetricsRecorder,
		limit: CapacityLimit,
		pluginId: string,
	): void {
		try {
			recorder.recordCapacityDrop(limit)
		} catch (error) {
			this.logRecordingFailure(error)
		}
		const now = Date.now()
		if (now - this.capacityLogAt[limit] < EXPORT_FAILURE_LOG_INTERVAL_MS) return
		this.capacityLogAt[limit] = now
		this.logger.warn('metrics operation capacity reached; measurement dropped', {
			limit,
			pluginId,
		})
	}

	private logRecordingFailure(error: unknown): void {
		const now = Date.now()
		if (now - this.recordingFailureLogAt < EXPORT_FAILURE_LOG_INTERVAL_MS) return
		this.recordingFailureLogAt = now
		this.logger.warn('metrics recording failed; business result preserved', {
			errorType: errorTypeOf(error),
		})
	}
}
