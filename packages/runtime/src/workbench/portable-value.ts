import type { RpcPromise } from '../capnweb'

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

export type WorkbenchDetached<Value> = Value extends null | boolean | number | string
	? Value
	: Value extends readonly unknown[]
		? { readonly [Index in keyof Value]: WorkbenchDetached<Value[Index]> }
		: Value extends object
			? {
					readonly [
						Key in keyof Value as Key extends typeof Symbol.dispose ? never : Key
					]: WorkbenchDetached<Value[Key]>
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

/**
 * Copies one Workbench RPC DTO into a deeply frozen portable-data tree and releases the awaited
 * top-level Cap'n Web result that owned it. This validates portability, not a domain schema.
 */
export function detachWorkbenchPortableValue<Input extends PromiseLike<unknown>>(
	input: Input,
	label?: string,
): Promise<WorkbenchDetached<WorkbenchResolvedPortableValue<Input>>>
export function detachWorkbenchPortableValue<Value>(
	input: Value,
	label?: string,
): WorkbenchDetached<Value>
export function detachWorkbenchPortableValue<Value>(
	input: Value | PromiseLike<Value>,
	label = 'Workbench RPC result',
): WorkbenchDetached<Value> | Promise<WorkbenchDetached<Value>> {
	if (isPromiseLike(input)) {
		return Promise.resolve(input).then((value) => detachResolvedWorkbenchValue(value, label))
	}
	return detachResolvedWorkbenchValue(input, label)
}

function detachResolvedWorkbenchValue<Value>(
	input: Value,
	label: string,
): WorkbenchDetached<Value> {
	const boundedLabel = readBoundedLabel(label)
	let dispose: (() => void) | undefined
	try {
		dispose = readOwnTransportDisposer(input)
	} catch {
		throw portableError('WORKBENCH_NON_PORTABLE_VALUE', boundedLabel)
	}

	let output: WorkbenchPortableValue | undefined
	let validationFailure: WorkbenchPortableValueError | undefined
	try {
		output = clonePortable(input, new Set(), 0, { nodes: 0, text: 0 }, dispose !== undefined)
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
	return output as WorkbenchDetached<Value>
}

function clonePortable(
	input: unknown,
	ancestors: Set<object>,
	depth: number,
	budget: PortableBudget,
	ignoreTopLevelDisposer = false,
): WorkbenchPortableValue {
	if (++budget.nodes > MAX_TOTAL_NODES) fail('WORKBENCH_PORTABLE_VALUE_TOO_LARGE')
	if (depth > MAX_TREE_DEPTH) fail('WORKBENCH_PORTABLE_VALUE_TOO_DEEP')
	if (typeof input === 'string') {
		consumeText(input, budget)
		return input
	}
	if (input === null) return null
	if (typeof input === 'boolean') return input
	if (typeof input === 'number') {
		if (!Number.isFinite(input)) fail('WORKBENCH_NON_PORTABLE_VALUE')
		return input
	}
	if (typeof input !== 'object') fail('WORKBENCH_NON_PORTABLE_VALUE')
	if (ancestors.has(input)) fail('WORKBENCH_NON_PORTABLE_VALUE')

	ancestors.add(input)
	try {
		if (Array.isArray(input)) {
			return clonePortableArray(input, ancestors, depth, budget, ignoreTopLevelDisposer)
		}
		return clonePortableObject(input, ancestors, depth, budget, ignoreTopLevelDisposer)
	} finally {
		ancestors.delete(input)
	}
}

function clonePortableArray(
	input: readonly unknown[],
	ancestors: Set<object>,
	depth: number,
	budget: PortableBudget,
	ignoreTopLevelDisposer: boolean,
): readonly WorkbenchPortableValue[] {
	if (Object.getPrototypeOf(input) !== Array.prototype) fail('WORKBENCH_NON_PORTABLE_VALUE')
	if (input.length > MAX_ARRAY_ITEMS) fail('WORKBENCH_PORTABLE_VALUE_TOO_LARGE')
	assertPortableSymbols(input, ignoreTopLevelDisposer)
	const descriptors = Object.getOwnPropertyDescriptors(input)
	for (const key of Object.keys(descriptors)) {
		if (key !== 'length' && !isArrayIndex(key, input.length)) {
			fail('WORKBENCH_NON_PORTABLE_VALUE')
		}
	}

	const output: WorkbenchPortableValue[] = []
	for (let index = 0; index < input.length; index += 1) {
		const descriptor = descriptors[index]
		if (!descriptor || !('value' in descriptor) || descriptor.value === undefined) {
			fail('WORKBENCH_NON_PORTABLE_VALUE')
		}
		output.push(clonePortable(descriptor.value, ancestors, depth + 1, budget))
	}
	return Object.freeze(output)
}

function clonePortableObject(
	input: object,
	ancestors: Set<object>,
	depth: number,
	budget: PortableBudget,
	ignoreTopLevelDisposer: boolean,
): Readonly<Record<string, WorkbenchPortableValue>> {
	const prototype = Object.getPrototypeOf(input)
	if (prototype !== Object.prototype && prototype !== null) {
		fail('WORKBENCH_NON_PORTABLE_VALUE')
	}
	assertPortableSymbols(input, ignoreTopLevelDisposer)
	const descriptors = Object.entries(Object.getOwnPropertyDescriptors(input))
	if (descriptors.length > MAX_OBJECT_FIELDS) fail('WORKBENCH_PORTABLE_VALUE_TOO_LARGE')

	const output: Record<string, WorkbenchPortableValue> = {}
	for (const [key, descriptor] of descriptors) {
		consumeText(key, budget)
		if (!('value' in descriptor) || descriptor.value === undefined) {
			fail('WORKBENCH_NON_PORTABLE_VALUE')
		}
		Object.defineProperty(output, key, {
			value: clonePortable(descriptor.value, ancestors, depth + 1, budget),
			enumerable: true,
			configurable: true,
			writable: true,
		})
	}
	return Object.freeze(output)
}

function assertPortableSymbols(input: object, ignoreTopLevelDisposer: boolean): void {
	for (const symbol of Object.getOwnPropertySymbols(input)) {
		if (ignoreTopLevelDisposer && symbol === Symbol.dispose) continue
		fail('WORKBENCH_NON_PORTABLE_VALUE')
	}
}

function readOwnTransportDisposer(input: unknown): (() => void) | undefined {
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
	return (
		input !== null &&
		(typeof input === 'object' || typeof input === 'function') &&
		typeof (input as { then?: unknown }).then === 'function'
	)
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
			? `[workbench/client] ${label} contains non-portable data`
			: code === 'WORKBENCH_PORTABLE_VALUE_TOO_DEEP'
				? `[workbench/client] ${label} exceeds the portable data nesting limit`
				: code === 'WORKBENCH_PORTABLE_VALUE_TOO_LARGE'
					? `[workbench/client] ${label} exceeds the portable data size limit`
					: `[workbench/client] ${label} transport disposer failed`
	return options === undefined
		? new WorkbenchPortableValueError(code, message)
		: new WorkbenchPortableValueError(code, message, options)
}

function fail(code: WorkbenchPortableValueErrorCode): never {
	throw portableError(code, 'Workbench RPC result')
}
