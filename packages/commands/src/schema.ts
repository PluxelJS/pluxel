import {
	JsonTypeBuilder,
	Kind,
	TransformKind,
	type ObjectOptions,
	type TObject,
	type TProperties,
	type TSchema,
} from '@sinclair/typebox'
import { TypeCompiler, type TypeCheck } from '@sinclair/typebox/compiler'
import type { ValueError } from '@sinclair/typebox/errors'
import { Value } from '@sinclair/typebox/value'
import { assertJsonValue, cloneJsonValue, JsonValueError } from './internal/json'
import { issue, type Infer, type Schema, type ValidationIssue, type Wire } from './types'

/** JSON-only TypeBox builder. JavaScript-only schemas cannot cross tool boundaries. */
export const Type = new JsonTypeBuilder()
export type {
	Static,
	StaticDecode,
	StaticEncode,
	TAnySchema,
	TProperties,
	TSchema,
} from '@sinclair/typebox'

/** Build an object schema that rejects undeclared properties. */
export function obj<P extends TProperties>(
	properties: P,
	options?: Omit<ObjectOptions, 'additionalProperties'>,
): TObject<P> {
	return Type.Object(properties, {
		...options,
		additionalProperties: false,
	})
}

/** Build an object schema that accepts undeclared JSON properties. */
export function openObj<P extends TProperties>(
	properties: P,
	options?: Omit<ObjectOptions, 'additionalProperties'>,
): TObject<P> {
	return Type.Object(properties, { ...options, additionalProperties: true })
}

const typecheckCache = new WeakMap<object, TypeCheck<any>>()
const normalizedSchemaCache = new WeakMap<object, Record<string, unknown>>()

export class SchemaDefaultError extends TypeError {
	readonly path: Array<string | number>

	constructor(path: Array<string | number>, reason: string) {
		super(`Default at ${formatSchemaPath(path)} does not satisfy its schema: ${reason}`)
		this.name = 'SchemaDefaultError'
		this.path = path
	}
}

function cloneValue<T>(value: T): T {
	if (Array.isArray(value)) return value.map((entry) => cloneValue(entry)) as T
	if (!value || typeof value !== 'object') return value
	const output = Object.create(Object.getPrototypeOf(value))
	for (const key of Reflect.ownKeys(value)) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key)
		if (!descriptor) continue
		if ('value' in descriptor) descriptor.value = cloneValue(descriptor.value)
		Object.defineProperty(output, key, descriptor)
	}
	return output
}

function normalizeStrictObjects<T>(value: T): T {
	if (Array.isArray(value)) return value.map((entry) => normalizeStrictObjects(entry)) as T
	if (!value || typeof value !== 'object') return value
	const output = Object.create(Object.getPrototypeOf(value))
	const current = value as Record<PropertyKey, unknown>
	for (const key of Reflect.ownKeys(current)) {
		const descriptor = Object.getOwnPropertyDescriptor(current, key)
		if (!descriptor) continue
		if ('value' in descriptor) descriptor.value = normalizeStrictObjects(descriptor.value)
		Object.defineProperty(output, key, descriptor)
	}
	const normalized = output as Record<PropertyKey, unknown>
	if (
		normalized.type === 'object' &&
		normalized.properties &&
		typeof normalized.properties === 'object' &&
		normalized.additionalProperties === undefined
	) {
		normalized.additionalProperties = false
	}
	return output
}

function decodeJsonPointerToken(value: string): string {
	return value.replaceAll('~1', '/').replaceAll('~0', '~')
}

function pathFromJsonPointer(raw: string): Array<string | number> | undefined {
	if (!raw || raw === '/') return undefined
	const output = raw
		.split('/')
		.filter(Boolean)
		.map(decodeJsonPointerToken)
		.map((token) => (/^(0|[1-9]\d*)$/.test(token) ? Number(token) : token))
	return output.length > 0 ? output : undefined
}

function issuesFromTypeBoxErrors(errors: Iterable<ValueError>): ValidationIssue[] {
	const output: ValidationIssue[] = []
	for (const current of errors) {
		const path = pathFromJsonPointer(current.path)
		output.push(
			issue(current.message?.trim() || 'Invalid value', {
				...(path ? { path } : {}),
				code: 'schema_validation',
			}),
		)
	}
	return output.length > 0 ? output : [issue('Invalid value')]
}

export function toJsonSchema(schema: Schema): Record<string, unknown> {
	assertPortableSchema(schema)
	const cached = normalizedSchemaCache.get(schema as object)
	if (cached) return jsonSchemaClone(cached)
	const normalized = normalizeStrictObjects(cloneValue(schema)) as Record<string, unknown>
	assertValidDefaults(normalized as Schema)
	normalizedSchemaCache.set(schema as object, normalized)
	return jsonSchemaClone(normalized)
}

function assertValidDefaults(schema: Schema): void {
	const references = collectSchemaReferences(schema)
	const seen = new WeakSet<object>()
	visit(schema, [])

	function visit(value: unknown, path: Array<string | number>): void {
		if (!value || typeof value !== 'object' || seen.has(value)) return
		seen.add(value)
		const current = value as Record<PropertyKey, unknown>
		if (typeof current[Kind] === 'string' && Object.hasOwn(current, 'default')) {
			const candidate = current.default
			if (!Value.Check(current as unknown as TSchema, references, candidate)) {
				const reason = Value.Errors(current as unknown as TSchema, references, candidate).First()
					?.message
				throw new SchemaDefaultError(path, reason?.trim() || 'Invalid value')
			}
		}
		if (Array.isArray(value)) {
			for (const [index, entry] of value.entries()) visit(entry, [...path, index])
			return
		}
		for (const [key, entry] of Object.entries(value)) visit(entry, [...path, key])
	}
}

function collectSchemaReferences(schema: Schema): TSchema[] {
	const output: TSchema[] = []
	const seen = new WeakSet<object>()
	visit(schema)
	return output

	function visit(value: unknown): void {
		if (!value || typeof value !== 'object' || seen.has(value)) return
		seen.add(value)
		const current = value as Record<PropertyKey, unknown>
		if (typeof current[Kind] === 'string' && typeof current.$id === 'string') {
			output.push(current as unknown as TSchema)
		}
		if (Array.isArray(value)) {
			for (const entry of value) visit(entry)
			return
		}
		for (const entry of Object.values(value)) visit(entry)
	}
}

function formatSchemaPath(path: readonly (string | number)[]): string {
	if (path.length === 0) return '$'
	return `$${path
		.map((part) =>
			typeof part === 'number' || /^[A-Za-z_$][\w$]*$/.test(part)
				? typeof part === 'number'
					? `[${part}]`
					: `.${part}`
				: `[${JSON.stringify(part)}]`,
		)
		.join('')}`
}

const jsonSchemaTypes = new Set([
	'null',
	'boolean',
	'object',
	'array',
	'number',
	'string',
	'integer',
])
const javascriptOnlyKinds = new Set([
	'Argument',
	'AsyncIterator',
	'BigInt',
	'Constructor',
	'Date',
	'Function',
	'Iterator',
	'Promise',
	'RegExp',
	'Symbol',
	'Uint8Array',
	'Undefined',
	'Void',
])

function assertPortableSchema(schema: Schema): void {
	const seen = new WeakSet<object>()
	visit(schema, '$')

	function visit(value: unknown, path: string): void {
		if (!value || typeof value !== 'object') return
		if (seen.has(value)) return
		seen.add(value)
		const current = value as Record<PropertyKey, unknown>
		const kind = current[Kind]
		if (typeof kind === 'string' && javascriptOnlyKinds.has(kind)) {
			throw new TypeError(`${kind} schema at ${path} is not JSON-compatible`)
		}
		if (typeof kind === 'string' && current.type !== undefined) {
			const types = Array.isArray(current.type) ? current.type : [current.type]
			if (!types.every((type) => typeof type === 'string' && jsonSchemaTypes.has(type))) {
				throw new TypeError(`Schema at ${path} uses a non-JSON type`)
			}
		}
		if (Array.isArray(value)) {
			for (const [index, entry] of value.entries()) visit(entry, `${path}[${index}]`)
			return
		}
		for (const [key, entry] of Object.entries(value)) visit(entry, `${path}.${key}`)
	}
}

function jsonSchemaClone(value: Record<string, unknown>): Record<string, unknown> {
	return cloneJsonValue(value, { ignoreSymbols: true }) as Record<string, unknown>
}

export type JsonValidationResult<T> =
	| { ok: true; value: T }
	| { ok: false; issues: ValidationIssue[] }
export type JsonValidator<T> = (value: unknown) => JsonValidationResult<T>

export type JsonCodec<S extends Schema> = {
	/** Clone strict JSON, apply declared defaults, then validate the wire input. */
	input: JsonValidator<Wire<S>>
	/** Clone strict JSON and validate exactly what the handler encoded. */
	output: JsonValidator<Wire<S>>
	decode(value: Wire<S>): Infer<S>
	encode(value: Infer<S>): Wire<S>
}

export function compileCodec<S extends Schema>(schema: S): JsonCodec<S> {
	const cached = typecheckCache.get(schema as object) as TypeCheck<S> | undefined
	const normalized =
		normalizedSchemaCache.get(schema as object) ??
		(normalizeStrictObjects(cloneValue(schema)) as Record<string, unknown>)
	if (!normalizedSchemaCache.has(schema as object)) {
		normalizedSchemaCache.set(schema as object, normalized)
	}
	const compiled = cached ?? TypeCompiler.Compile(normalized as S)
	if (!cached) typecheckCache.set(schema as object, compiled as TypeCheck<any>)
	const transformed = hasTransform(normalized)
	const validate = (value: unknown, defaults: boolean): JsonValidationResult<Wire<S>> => {
		let candidate: unknown
		try {
			candidate = cloneJsonValue(value)
			if (defaults) {
				candidate = Value.Default(normalized as S, candidate)
				assertJsonValue(candidate)
			}
		} catch (error) {
			return { ok: false, issues: [jsonValueIssue(error)] }
		}
		return compiled.Check(candidate)
			? { ok: true, value: candidate as Wire<S> }
			: {
					ok: false,
					issues: issuesFromTypeBoxErrors(compiled.Errors(candidate)),
				}
	}
	return {
		input: (value) => validate(value, true),
		output: (value) => validate(value, false),
		decode: transformed
			? (value) => compiled.Decode(value)
			: (value) => value as unknown as Infer<S>,
		encode: transformed
			? (value) => compiled.Encode(value)
			: (value) => value as unknown as Wire<S>,
	}
}

function jsonValueIssue(error: unknown): ValidationIssue {
	return issue(
		error instanceof JsonValueError ? error.message : 'Value could not be read as JSON',
		{
			...(error instanceof JsonValueError && error.path.length > 0 ? { path: error.path } : {}),
			code: 'non_json_value',
			...(error instanceof JsonValueError ? { meta: { reason: error.reason } } : {}),
		},
	)
}

function hasTransform(value: unknown, seen = new WeakSet<object>()): boolean {
	if (!value || typeof value !== 'object') return false
	if (seen.has(value)) return false
	seen.add(value)
	const current = value as Record<PropertyKey, unknown>
	if (current[TransformKind] !== undefined) return true
	if (Array.isArray(value)) return value.some((entry) => hasTransform(entry, seen))
	return Object.values(value).some((entry) => hasTransform(entry, seen))
}
