import { RpcPromise, RpcStub } from 'capnweb'

const MAX_TREE_DEPTH = 64
const MAX_ARRAY_ITEMS = 10_000
const MAX_OBJECT_FIELDS = 10_000
const MAX_TEXT_LENGTH = 1_000_000
const MAX_TOTAL_NODES = 50_000
const MAX_TOTAL_TEXT = 4_000_000
const MAX_LABEL_LENGTH = 256

type PortableBudget = { nodes: number; text: number }

export type WorkbenchPortableValue =
	| null
	| boolean
	| number
	| string
	| readonly WorkbenchPortableValue[]
	| { readonly [key: string]: WorkbenchPortableValue }

export type WorkbenchSnapshot<Value> = Value extends null | boolean | number | string
	? Value
	: Value extends readonly unknown[]
		? { readonly [Index in keyof Value]: WorkbenchSnapshot<Value[Index]> }
		: Value extends object
			? {
					readonly [
						Key in keyof Value as Key extends typeof Symbol.dispose ? never : Key
					]: WorkbenchSnapshot<Value[Key]>
				}
			: never

export type WorkbenchResolvedPortableValue<Value> =
	Value extends RpcPromise<infer Result>
		? Result extends unknown
			? Value extends RpcPromise<Result>
				? Result
				: never
			: never
		: Awaited<Value>

export type WorkbenchPortableValueErrorCode =
	| 'WORKBENCH_NON_PORTABLE_VALUE'
	| 'WORKBENCH_PORTABLE_VALUE_TOO_DEEP'
	| 'WORKBENCH_PORTABLE_VALUE_TOO_LARGE'
	| 'WORKBENCH_TRANSPORT_DISPOSE_FAILED'

export class WorkbenchPortableValueError extends TypeError {
	readonly code: WorkbenchPortableValueErrorCode
	declare readonly cause?: unknown

	constructor(
		code: WorkbenchPortableValueErrorCode,
		message: string,
		options?: Readonly<{ cause: unknown }>,
	) {
		super(message, options)
		this.name = 'WorkbenchPortableValueError'
		this.code = code
	}
}

/** Validate a producer-owned DTO without copying, freezing, disposing, or changing its identity. */
export function assertWorkbenchDto(
	value: unknown,
	label = 'Workbench DTO',
): asserts value is WorkbenchPortableValue {
	try {
		validatePortable(value, new Set(), 0, { nodes: 0, text: 0 })
	} catch (error) {
		throw portableError(
			error instanceof WorkbenchPortableValueError ? error.code : 'WORKBENCH_NON_PORTABLE_VALUE',
			readBoundedLabel(label),
		)
	}
}

/**
 * Consumes a value or awaited RPC result, validates and freezes its data tree in place, and releases
 * its top-level transport owner. The caller transfers the entire tree: do not pass borrowed mutable
 * state. Returns the same object, without transport metadata. This validates portability, not a
 * domain schema. Consumption also applies on failure; callers must not reuse the input.
 */
export function consumeWorkbenchValue<Input extends PromiseLike<unknown>>(
	input: Input,
	label?: string,
): Promise<WorkbenchSnapshot<WorkbenchResolvedPortableValue<Input>>>
export function consumeWorkbenchValue<Value>(input: Value, label?: string): WorkbenchSnapshot<Value>
export function consumeWorkbenchValue<Value>(
	input: Value | PromiseLike<Value>,
	label = 'Workbench RPC result',
): WorkbenchSnapshot<Value> | Promise<WorkbenchSnapshot<Value>> {
	if (isPromiseLike(input)) {
		return Promise.resolve(input).then((value) => consumeResolvedWorkbenchValue(value, label))
	}
	return consumeResolvedWorkbenchValue(input, label)
}

function consumeResolvedWorkbenchValue<Value>(
	input: Value,
	label: string,
): WorkbenchSnapshot<Value> {
	const boundedLabel = readBoundedLabel(label)
	let dispose: (() => void) | undefined
	try {
		dispose = readOwnTransportDisposer(input)
	} catch {
		throw portableError('WORKBENCH_NON_PORTABLE_VALUE', boundedLabel)
	}

	const objects: object[] = []
	let validationFailure: WorkbenchPortableValueError | undefined
	try {
		validatePortable(input, new Set(), 0, { nodes: 0, text: 0 }, objects, dispose !== undefined)
		if (dispose && !Reflect.deleteProperty(input as object, Symbol.dispose)) {
			fail('WORKBENCH_NON_PORTABLE_VALUE')
		}
		for (const object of objects) Object.freeze(object)
	} catch (error) {
		validationFailure =
			error instanceof WorkbenchPortableValueError
				? portableError(error.code, boundedLabel)
				: portableError('WORKBENCH_NON_PORTABLE_VALUE', boundedLabel)
	}

	let disposeFailed = false
	let disposeFailure: unknown
	if (dispose) {
		try {
			dispose.call(input)
		} catch (error) {
			disposeFailed = true
			disposeFailure = error
		}
	}

	if (validationFailure) {
		if (!disposeFailed) throw validationFailure
		throw new WorkbenchPortableValueError(validationFailure.code, validationFailure.message, {
			cause: disposeFailure,
		})
	}
	if (disposeFailed) {
		throw portableError('WORKBENCH_TRANSPORT_DISPOSE_FAILED', boundedLabel, {
			cause: disposeFailure,
		})
	}
	return input as WorkbenchSnapshot<Value>
}

function validatePortable(
	input: unknown,
	ancestors: Set<object>,
	depth: number,
	budget: PortableBudget,
	objects?: object[],
	ignoreTopLevelDisposer = false,
): void {
	if (++budget.nodes > MAX_TOTAL_NODES) fail('WORKBENCH_PORTABLE_VALUE_TOO_LARGE')
	if (depth > MAX_TREE_DEPTH) fail('WORKBENCH_PORTABLE_VALUE_TOO_DEEP')
	if (typeof input === 'string') {
		consumeText(input, budget)
		return
	}
	if (input === null || typeof input === 'boolean') return
	if (typeof input === 'number') {
		if (!Number.isFinite(input)) fail('WORKBENCH_NON_PORTABLE_VALUE')
		return
	}
	if (typeof input !== 'object' || ancestors.has(input)) fail('WORKBENCH_NON_PORTABLE_VALUE')

	const array = Array.isArray(input)
	const prototype = Object.getPrototypeOf(input)
	if (
		array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null
	) {
		fail('WORKBENCH_NON_PORTABLE_VALUE')
	}
	assertPortableSymbols(input, ignoreTopLevelDisposer)
	const descriptors = Object.getOwnPropertyDescriptors(input)
	const keys = Object.keys(descriptors)
	if (array) {
		if (input.length > MAX_ARRAY_ITEMS) fail('WORKBENCH_PORTABLE_VALUE_TOO_LARGE')
		if (
			keys.length !== input.length + 1 ||
			keys.some((key) => key !== 'length' && !isArrayIndex(key, input.length))
		) {
			fail('WORKBENCH_NON_PORTABLE_VALUE')
		}
	} else if (keys.length > MAX_OBJECT_FIELDS) {
		fail('WORKBENCH_PORTABLE_VALUE_TOO_LARGE')
	}

	ancestors.add(input)
	try {
		for (const key of keys) {
			if (array && key === 'length') continue
			if (!array) consumeText(key, budget)
			const descriptor = descriptors[key]!
			if (!('value' in descriptor) || descriptor.value === undefined || !descriptor.enumerable) {
				fail('WORKBENCH_NON_PORTABLE_VALUE')
			}
			validatePortable(descriptor.value, ancestors, depth + 1, budget, objects)
		}
		objects?.push(input)
	} finally {
		ancestors.delete(input)
	}
}

function assertPortableSymbols(input: object, ignoreTopLevelDisposer: boolean): void {
	for (const symbol of Object.getOwnPropertySymbols(input)) {
		if (ignoreTopLevelDisposer && symbol === Symbol.dispose) continue
		fail('WORKBENCH_NON_PORTABLE_VALUE')
	}
}

function readOwnTransportDisposer(input: unknown): (() => void) | undefined {
	if (input instanceof RpcStub) return input[Symbol.dispose]
	if ((typeof input !== 'object' && typeof input !== 'function') || input === null) {
		return undefined
	}
	const descriptor = Object.getOwnPropertyDescriptor(input, Symbol.dispose)
	return descriptor && 'value' in descriptor && typeof descriptor.value === 'function'
		? descriptor.value
		: undefined
}

function consumeText(input: string, budget: PortableBudget): void {
	if (input.length > MAX_TEXT_LENGTH) fail('WORKBENCH_PORTABLE_VALUE_TOO_LARGE')
	budget.text += input.length
	if (budget.text > MAX_TOTAL_TEXT) fail('WORKBENCH_PORTABLE_VALUE_TOO_LARGE')
}

function isArrayIndex(key: string, length: number): boolean {
	if (!/^(0|[1-9]\d*)$/.test(key)) return false
	const index = Number(key)
	return Number.isSafeInteger(index) && index >= 0 && index < length
}

function isPromiseLike(input: unknown): input is PromiseLike<unknown> {
	if (input instanceof RpcPromise) return true
	if (input === null || (typeof input !== 'object' && typeof input !== 'function')) return false
	// Read ordinary thenables without executing an untrusted accessor before portable validation.
	for (
		let current: object | null = input;
		current !== null;
		current = Object.getPrototypeOf(current)
	) {
		const descriptor = Object.getOwnPropertyDescriptor(current, 'then')
		if (descriptor) return 'value' in descriptor && typeof descriptor.value === 'function'
	}
	return false
}

function readBoundedLabel(input: string): string {
	if (typeof input !== 'string' || input.length === 0) return 'Workbench RPC result'
	return input.slice(0, MAX_LABEL_LENGTH)
}

function portableError(
	code: WorkbenchPortableValueErrorCode,
	label: string,
	options?: Readonly<{ cause: unknown }>,
): WorkbenchPortableValueError {
	const message =
		code === 'WORKBENCH_NON_PORTABLE_VALUE'
			? `[workbench] ${label} contains non-portable data`
			: code === 'WORKBENCH_PORTABLE_VALUE_TOO_DEEP'
				? `[workbench] ${label} exceeds the portable data nesting limit`
				: code === 'WORKBENCH_PORTABLE_VALUE_TOO_LARGE'
					? `[workbench] ${label} exceeds the portable data size limit`
					: `[workbench] ${label} transport disposer failed`
	return options === undefined
		? new WorkbenchPortableValueError(code, message)
		: new WorkbenchPortableValueError(code, message, options)
}

function fail(code: WorkbenchPortableValueErrorCode): never {
	throw portableError(code, 'Workbench RPC result')
}
