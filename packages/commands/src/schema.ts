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
import { deepFreeze } from './internal/freeze'
import {
	assertJsonValue,
	cloneJsonValue,
	JsonValueError,
	markStrictJsonSnapshot,
} from './internal/json'
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

const compiledSchemaCache = new WeakMap<object, CompiledSchema<any>>()

export class SchemaDefaultError extends TypeError {
	readonly path: Array<string | number>

	constructor(path: Array<string | number>, reason: string) {
		super(`Default at ${formatSchemaPath(path)} does not satisfy its schema: ${reason}`)
		this.name = 'SchemaDefaultError'
		this.path = path
	}
}

export class SchemaReferenceError extends TypeError {
	readonly reference: string

	constructor(reference: string) {
		super(
			`Schema reference ${JSON.stringify(reference)} is not embedded in the command schema; use Type.Module().Import() for a self-contained reference`,
		)
		this.name = 'SchemaReferenceError'
		this.reference = reference
	}
}

export class SchemaCompilationError extends Error {
	constructor(cause: unknown) {
		super('Schema could not be compiled', { cause })
		this.name = 'SchemaCompilationError'
	}
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

function assertValidDefaults(schema: Schema, references: TSchema[]): void {
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

function assertPortableSchema(schema: Schema, references: TSchema[]): void {
	const seen = new WeakSet<object>()
	const embeddedIds = new Set(references.map((reference) => reference.$id!))
	visit(schema, '$')

	function visit(value: unknown, path: string): void {
		if (!value || typeof value !== 'object') return
		if (seen.has(value)) return
		seen.add(value)
		const current = value as Record<PropertyKey, unknown>
		const kind = current[Kind]
		if (
			typeof current.$ref === 'string' &&
			!current.$ref.startsWith('#') &&
			!embeddedIds.has(current.$ref)
		) {
			throw new SchemaReferenceError(current.$ref)
		}
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

export type CompiledSchema<S extends Schema> = {
	readonly jsonSchema: Readonly<Record<string, unknown>>
	/** Clone strict JSON, apply declared defaults, then validate the wire input. */
	readonly validateInput: JsonValidator<Wire<S>>
	/** Clone strict JSON and validate exactly what the handler encoded. */
	readonly validateOutput: JsonValidator<Wire<S>>
	readonly decode: (value: Wire<S>) => Infer<S>
	readonly encode: (value: Infer<S>) => Wire<S>
}

export function compileSchema<S extends Schema>(schema: S): CompiledSchema<S> {
	const cached = compiledSchemaCache.get(schema as object) as CompiledSchema<S> | undefined
	if (cached) return cached
	const normalized = normalizeStrictObjects(schema) as S
	const references = collectSchemaReferences(normalized)
	assertPortableSchema(normalized, references)
	assertValidDefaults(normalized, references)
	const jsonSchema = markStrictJsonSnapshot(deepFreeze(jsonSchemaClone(normalized)))
	let compiled: TypeCheck<S>
	try {
		compiled = TypeCompiler.Compile(normalized)
	} catch (error) {
		throw new SchemaCompilationError(error)
	}
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
	const output: CompiledSchema<S> = Object.freeze({
		jsonSchema,
		validateInput: (value) => validate(value, true),
		validateOutput: (value) => validate(value, false),
		decode: transformed
			? (value) => compiled.Decode(value)
			: (value) => value as unknown as Infer<S>,
		encode: transformed
			? (value) => compiled.Encode(value)
			: (value) => value as unknown as Wire<S>,
	})
	compiledSchemaCache.set(schema as object, output as CompiledSchema<any>)
	return output
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
