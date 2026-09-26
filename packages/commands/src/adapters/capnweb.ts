import type { CommandContext, CommandFailure, Command } from '../types'
import { RpcPromise, RpcStub, RpcTarget, serialize } from 'capnweb'

type Methods = Readonly<Record<string, Command<any, unknown, any>>>
type ContextOf<C> = C extends Command<any, unknown, infer Ctx> ? Ctx : never
type InputOf<C> = C extends Command<infer Input, unknown, any> ? Input : never
type OutputOf<C> = C extends Command<any, infer Output, any> ? Output : never
type Intersection<U> = (U extends unknown ? (value: U) => void : never) extends (
	value: infer I,
) => void
	? I
	: never
type ContextFor<T extends Methods> = Intersection<ContextOf<T[keyof T]>> & CommandContext

function isReservedDataKey(key: string): boolean {
	return key in Object.prototype || key === 'toJSON'
}

/** A Command failure projected without its local-only `cause`. */
export type CapnwebCommandFailure =
	| {
			readonly code: 'INPUT_VALIDATION'
			readonly message: string
			readonly issues: Extract<CommandFailure, { code: 'INPUT_VALIDATION' }>['issues']
	  }
	| { readonly code: 'REJECTED'; readonly message: string; readonly reason: string }
	| {
			readonly code: Exclude<CommandFailure['code'], 'INPUT_VALIDATION' | 'REJECTED'>
			readonly message: string
	  }

/** The JSON data result of one generated RPC method. A void success is represented by `null`. */
export type CapnwebCommandResult<T> =
	| { readonly ok: true; readonly value: T extends void ? null : T }
	| { readonly ok: false; readonly error: CapnwebCommandFailure }

type TargetMethods<T extends Methods> = {
	readonly [K in keyof T]: (input: InputOf<T[K]>) => Promise<CapnwebCommandResult<OutputOf<T[K]>>>
}

/**
 * Make selected Commands into native Cap'n Web prototype methods. Construct the target with a
 * trusted context; remote callers provide only each method's input.
 */
export function toCapnweb<const T extends Methods>(
	methods: T,
): new (context: ContextFor<T>) => RpcTarget & TargetMethods<T> {
	if (
		!methods ||
		typeof methods !== 'object' ||
		Array.isArray(methods) ||
		(Object.getPrototypeOf(methods) !== Object.prototype && Object.getPrototypeOf(methods) !== null)
	) {
		throw new TypeError("Cap'n Web methods must be an own-property record")
	}
	const contexts = new WeakMap<RpcTarget, ContextFor<T>>()
	class Target extends RpcTarget {
		constructor(context: ContextFor<T>) {
			super()
			contexts.set(this, context)
		}
	}

	for (const name of Reflect.ownKeys(methods)) {
		if (typeof name !== 'string') throw new TypeError("Cap'n Web method names must be strings")
		const property = Object.getOwnPropertyDescriptor(methods, name)!
		if (!property.enumerable || !('value' in property)) {
			throw new TypeError(`Invalid Cap'n Web command method: ${name}`)
		}
		const command = property.value as Command<any, unknown, any>
		if (
			!name ||
			name === 'constructor' ||
			name === 'toJSON' ||
			name in RpcStub.prototype ||
			name in RpcPromise.prototype ||
			name in Target.prototype ||
			!command ||
			typeof command.execute !== 'function'
		) {
			throw new TypeError(`Invalid Cap'n Web command method: ${name}`)
		}
		assertInputFields(command.descriptor.inputSchema)
		const execute = command.execute.bind(command)
		Object.defineProperty(Target.prototype, name, {
			value: async function (this: RpcTarget, input: unknown) {
				const result = await execute(input, contexts.get(this)!)
				try {
					const projected = result.isErr()
						? { ok: false, error: publicFailure(result.error) }
						: { ok: true, value: strictJson(result.value === undefined ? null : result.value) }
					serialize(projected)
					return projected
				} catch {
					return {
						ok: false,
						error: { code: 'OUTPUT_ENCODING', message: 'Command output is not JSON' },
					}
				}
			},
			configurable: false,
			enumerable: false,
			writable: false,
		})
	}
	return Target as new (context: ContextFor<T>) => RpcTarget & TargetMethods<T>
}

function assertInputFields(schema: unknown, visited = new WeakSet<object>()): void {
	if (!schema || typeof schema !== 'object' || visited.has(schema)) return
	visited.add(schema)
	if (Array.isArray(schema)) {
		for (const item of schema) assertInputFields(item, visited)
		return
	}
	const node = schema as Record<string, unknown>
	if (node.type === 'object' && node.properties && typeof node.properties === 'object') {
		for (const name of Object.keys(node.properties)) {
			if (isReservedDataKey(name)) {
				throw new TypeError(`Cap'n Web cannot preserve Command input field: ${name}`)
			}
		}
	}
	for (const value of Object.values(node)) assertInputFields(value, visited)
}

function publicFailure(failure: CommandFailure): CapnwebCommandFailure {
	if (failure.code === 'INPUT_VALIDATION') {
		return { code: failure.code, message: failure.message, issues: strictJson(failure.issues) }
	}
	if (failure.code === 'REJECTED') {
		return { code: failure.code, message: failure.message, reason: failure.reason }
	}
	return { code: failure.code, message: failure.message }
}

/** Copy only plain JSON data, rejecting silent JSON.stringify coercions and accessors. */
function strictJson<T>(value: T, ancestors = new WeakSet<object>()): T {
	if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
	if (typeof value === 'number' && Number.isFinite(value)) return value
	if (typeof value !== 'object' || ancestors.has(value)) throw new TypeError('Not JSON data')
	const array = Array.isArray(value)
	if (!array && Object.getPrototypeOf(value) !== Object.prototype)
		throw new TypeError('Not JSON data')
	ancestors.add(value)
	try {
		const copy: Record<string, unknown> | unknown[] = array ? [] : {}
		const keys = Reflect.ownKeys(value)
		for (const key of keys) {
			if (array && key === 'length') continue
			if (typeof key !== 'string') throw new TypeError('Not JSON data')
			if (isReservedDataKey(key)) throw new TypeError("Cap'n Web does not preserve this key")
			if (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= (value as unknown[]).length)) {
				throw new TypeError('Not JSON data')
			}
			const property = Object.getOwnPropertyDescriptor(value, key)!
			if (!property.enumerable || !('value' in property)) throw new TypeError('Not JSON data')
			Object.defineProperty(copy, key, {
				value: strictJson(property.value, ancestors),
				enumerable: true,
				configurable: true,
				writable: true,
			})
		}
		if (array && copy.length !== value.length) throw new TypeError('Not JSON data')
		return copy as T
	} finally {
		ancestors.delete(value)
	}
}
