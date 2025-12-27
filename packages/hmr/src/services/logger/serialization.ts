import { dump as dumpValue } from '@poppinss/dumper/console'
import type { ConsoleDumpConfig } from '@poppinss/dumper/console/types'
import pino, { type LogFn, type Logger, type LoggerOptions } from 'pino'
import type { LoggerDumperConfig } from './loggerRuntimeConfig'

const clampNumber = (input: number, fallback: number, min = 1) =>
	Number.isFinite(input) ? Math.max(min, Math.floor(input)) : fallback

const DEFAULT_DUMPER_CONFIG: LoggerDumperConfig = {
	depth: 4,
	collectionLimit: 50,
	typedArrayLimit: 64,
	bufferPreview: 64,
	stringLimit: 4000,
}
let dumperSettings: LoggerDumperConfig = { ...DEFAULT_DUMPER_CONFIG }

const identityStyle = (value: string) => value
const dumperPlainStyles: ConsoleDumpConfig['styles'] = {
	braces: identityStyle,
	brackets: identityStyle,
	string: identityStyle,
	number: identityStyle,
	boolean: identityStyle,
	bigInt: identityStyle,
	undefined: identityStyle,
	null: identityStyle,
	symbol: identityStyle,
	regex: identityStyle,
	date: identityStyle,
	buffer: identityStyle,
	functionLabel: identityStyle,
	classLabel: identityStyle,
	objectLabel: identityStyle,
	objectKey: identityStyle,
	objectKeyPrefix: identityStyle,
	arrayLabel: identityStyle,
	mapLabel: identityStyle,
	setLabel: identityStyle,
	collapseLabel: identityStyle,
	circularLabel: identityStyle,
	getterLabel: identityStyle,
	weakSetLabel: identityStyle,
	weakRefLabel: identityStyle,
	weakMapLabel: identityStyle,
	observableLabel: identityStyle,
	promiseLabel: identityStyle,
	generatorLabel: identityStyle,
	prototypeLabel: identityStyle,
	blobLabel: identityStyle,
	unknownLabel: identityStyle,
} as const

let dumperConfig: ConsoleDumpConfig = buildDumperConfig(dumperSettings)

function buildDumperConfig(settings: LoggerDumperConfig): ConsoleDumpConfig {
	return {
		depth: settings.depth,
		showHidden: false,
		inspectObjectPrototype: false,
		inspectArrayPrototype: false,
		inspectStaticMembers: false,
		maxArrayLength: settings.collectionLimit,
		maxStringLength: settings.stringLimit,
		styles: dumperPlainStyles,
	}
}

function normalizeDumperConfig(config: LoggerDumperConfig): LoggerDumperConfig {
	return {
		depth: clampNumber(config.depth, DEFAULT_DUMPER_CONFIG.depth, 1),
		collectionLimit: clampNumber(config.collectionLimit, DEFAULT_DUMPER_CONFIG.collectionLimit, 1),
		typedArrayLimit: clampNumber(config.typedArrayLimit, DEFAULT_DUMPER_CONFIG.typedArrayLimit, 1),
		bufferPreview: clampNumber(config.bufferPreview, DEFAULT_DUMPER_CONFIG.bufferPreview, 4),
		stringLimit: clampNumber(config.stringLimit, DEFAULT_DUMPER_CONFIG.stringLimit, 64),
	}
}

export function configureSerialization(config: LoggerDumperConfig) {
	dumperSettings = normalizeDumperConfig(config)
	dumperConfig = buildDumperConfig(dumperSettings)
}

const describeWithDumper = (value: unknown): string => {
	try {
		const raw = dumpValue(value, dumperConfig)
		return raw.trimEnd()
	} catch {
		return Object.prototype.toString.call(value)
	}
}

const isPlainObject = (value: object): value is Record<string, unknown> => {
	const proto = Object.getPrototypeOf(value)
	return proto === null || proto === Object.prototype
}

const symbolKey = (sym: symbol) => `Symbol(${sym.description ?? sym.toString().slice(7, -1)})`

const cloneObject = (
	value: Record<string | symbol, unknown>,
	seen: WeakSet<object>,
	depth: number,
) => {
	const out: Record<string, unknown> = {}
	for (const key of Object.keys(value)) {
		try {
			out[key] = toPlain(value[key], seen, depth)
		} catch {
			out[key] = '[Unserializable]'
		}
	}
	for (const sym of Object.getOwnPropertySymbols(value)) {
		if (!Object.prototype.propertyIsEnumerable.call(value, sym)) continue
		const name = symbolKey(sym)
		try {
			out[name] = toPlain(value[sym], seen, depth)
		} catch {
			out[name] = '[Unserializable]'
		}
	}
	return out
}

const mapToPlain = (value: Map<unknown, unknown>, seen: WeakSet<object>, depth: number) => {
	const entries: Array<[unknown, unknown]> = []
	let index = 0
	for (const [k, v] of value.entries()) {
		if (index >= dumperSettings.collectionLimit) break
		entries.push([toPlain(k, seen, depth), toPlain(v, seen, depth)])
		index++
	}
	const payload: Record<string, unknown> = {
		type: 'Map',
		size: value.size,
		entries,
	}
	if (value.size > entries.length) payload.truncated = value.size - entries.length
	return payload
}

const setToPlain = (value: Set<unknown>, seen: WeakSet<object>, depth: number) => {
	const values: unknown[] = []
	let index = 0
	for (const item of value.values()) {
		if (index >= dumperSettings.collectionLimit) break
		values.push(toPlain(item, seen, depth))
		index++
	}
	const payload: Record<string, unknown> = {
		type: 'Set',
		size: value.size,
		values,
	}
	if (value.size > values.length) payload.truncated = value.size - values.length
	return payload
}

const bufferToPlain = (value: Buffer) => {
	const preview = value.subarray(0, dumperSettings.bufferPreview)
	return {
		type: 'Buffer',
		byteLength: value.byteLength,
		preview: preview.toString('hex'),
	}
}

const typedArrayToPlain = (value: ArrayBufferView) => {
	if (value instanceof DataView) {
		return {
			type: 'DataView',
			byteLength: value.byteLength,
		}
	}
	const limit = Math.min(dumperSettings.typedArrayLimit, (value as any).length ?? 0)
	const values = Array.from({ length: limit }, (_, idx) => (value as any)[idx])
	const payload: Record<string, unknown> = {
		type: value.constructor?.name ?? 'TypedArray',
		length: (value as any).length ?? value.byteLength,
		values,
	}
	const totalLength = (value as any).length ?? 0
	if (typeof totalLength === 'number' && totalLength > values.length) {
		payload.truncated = totalLength - values.length
	}
	return payload
}

const toPlain = (
	value: unknown,
	seen: WeakSet<object> = new WeakSet(),
	depth = dumperSettings.depth,
): unknown => {
	if (value === null || value === undefined) return value
	const valueType = typeof value
	if (valueType === 'string' || valueType === 'number' || valueType === 'boolean') {
		return value
	}
	if (valueType === 'bigint') {
		return `${(value as bigint).toString()}n`
	}
	if (valueType === 'symbol') {
		const symbolValue = value as symbol
		return symbolValue.description ? `Symbol(${symbolValue.description})` : symbolValue.toString()
	}
	if (valueType === 'function') return describeWithDumper(value)
	if (valueType !== 'object') return value
	const objectValue = value as Record<string | symbol, unknown>
	if (seen.has(objectValue)) return '[Circular]'
	if (depth <= 0) return `[MaxDepth:${value.constructor?.name ?? 'Object'}]`
	seen.add(objectValue)
	try {
		const nextDepth = depth - 1
		if (value instanceof Date) return value.toISOString()
		if (value instanceof RegExp) return value.toString()
		if (value instanceof URL || value instanceof URLSearchParams) return value.toString()
		if (Buffer.isBuffer(value)) return bufferToPlain(value)
		if (value instanceof ArrayBuffer) return bufferToPlain(Buffer.from(value))
		if (ArrayBuffer.isView(value)) return typedArrayToPlain(value)
		if (Array.isArray(value)) return value.map((entry) => toPlain(entry, seen, nextDepth))
		if (value instanceof Map) return mapToPlain(value, seen, nextDepth)
		if (value instanceof Set) return setToPlain(value, seen, nextDepth)
		if (value instanceof WeakMap || value instanceof WeakSet) return `[${value.constructor.name}]`
		if (value instanceof Promise) return describeWithDumper(value)
		if (value instanceof Error) return value
		let maybeJSON: unknown
		try {
			if (typeof (value as any)?.toJSON === 'function') {
				maybeJSON = (value as any).toJSON()
			}
		} catch {
			maybeJSON = undefined
		}
		if (maybeJSON && maybeJSON !== value) return toPlain(maybeJSON, seen, nextDepth)
		const cloned = cloneObject(objectValue, seen, nextDepth)
		if (isPlainObject(value)) return cloned
		const typeName = value.constructor?.name
		if (typeName && !('__type' in cloned)) return { __type: typeName, ...cloned }
		return cloned
	} finally {
		seen.delete(objectValue)
	}
}

export function makeErrSerializer() {
	const visit = (e: unknown): any => {
		if (!(e instanceof Error)) return toPlain(e)
		const out: any = pino.stdSerializers.err(e as any)
		for (const k of Object.keys(e as any)) {
			try {
				;(out as any)[k] = toPlain((e as any)[k])
			} catch {
				/* ignore */
			}
		}
		if (out.errors !== undefined) out.errors = toPlain(out.errors)
		if (out.aggregateErrors !== undefined) out.aggregateErrors = toPlain(out.aggregateErrors)
		const c = (e as any).cause
		if (c instanceof Error) out.cause = visit(c)
		else if (c !== undefined) out.cause = toPlain(c)
		return out
	}
	return visit
}

interface DumperHookOptions {
	transformAllObjects?: boolean
}

export function createDumperLogHook(
	opts: DumperHookOptions = {},
): NonNullable<LoggerOptions['hooks']>['logMethod'] {
	const { transformAllObjects = false } = opts
	const transform = (v: unknown) => {
		if (v instanceof Error) return v
		return toPlain(v)
	}

	return function logMethod(this: Logger, args: Parameters<LogFn>, method: LogFn, level: number) {
		void level
		if (!args || args.length === 0) return method.apply(this, args)

		const newArgs = Array.prototype.slice.call(args) as Parameters<LogFn>

		if (typeof newArgs[0] === 'string') {
			let errIdx = -1
			for (let i = 1; i < newArgs.length; i++) {
				if (newArgs[i] instanceof Error) {
					errIdx = i
					break
				}
			}
			if (errIdx !== -1) {
				const err = newArgs.splice(errIdx, 1)[0]
				newArgs.unshift({ err })
			}
			if (transformAllObjects) {
				for (let i = 1; i < newArgs.length; i++) newArgs[i] = transform(newArgs[i])
			}
		} else {
			newArgs[0] = transform(newArgs[0])
			if (transformAllObjects) {
				for (let i = 1; i < newArgs.length; i++) newArgs[i] = transform(newArgs[i])
			}
		}

		return method.apply(this, newArgs)
	}
}
