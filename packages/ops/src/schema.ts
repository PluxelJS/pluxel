import {
	Type as TypeBoxType,
	type ObjectOptions,
	type TObject,
	type TProperties,
} from '@sinclair/typebox'
import { TypeCompiler, type TypeCheck } from '@sinclair/typebox/compiler'
import type { ValueError } from '@sinclair/typebox/errors'
import { Value } from '@sinclair/typebox/value'
import { issue, type Infer, type Schema, type ValidationIssue } from './types'

export const Type = TypeBoxType
export * as TypeBox from '@sinclair/typebox'
export type { Static, TAnySchema, TProperties, TSchema } from '@sinclair/typebox'

export const obj = <P extends TProperties>(
	properties: P,
	options?: Omit<ObjectOptions, 'additionalProperties'> & { additionalProperties?: boolean },
): TObject<P> =>
	Type.Object(properties, {
		...options,
		additionalProperties: options?.additionalProperties ?? false,
	})

export const openObj = <P extends TProperties>(
	properties: P,
	options?: Omit<ObjectOptions, 'additionalProperties'>,
): TObject<P> => Type.Object(properties, { ...options, additionalProperties: true })

const TYPECHECK_CACHE = new WeakMap<object, TypeCheck<any>>()
const NORMALIZED_SCHEMA_CACHE = new WeakMap<object, Record<string, unknown>>()

const decodeJsonPointerToken = (value: string) => value.replaceAll('~1', '/').replaceAll('~0', '~')

const pathFromJsonPointer = (raw: string): Array<string | number> | undefined => {
	const pointer = String(raw ?? '')
	if (!pointer || pointer === '/') return undefined
	const out: Array<string | number> = []
	for (const token of pointer.split('/').filter(Boolean).map(decodeJsonPointerToken)) {
		if (/^(0|[1-9]\d*)$/.test(token)) out.push(Number(token))
		else out.push(token)
	}
	return out.length > 0 ? out : undefined
}

const issuesFromTypeBoxErrors = (errors: Iterable<ValueError>): ValidationIssue[] => {
	const out: ValidationIssue[] = []
	for (const current of errors) {
		const path = pathFromJsonPointer(current.path)
		out.push(
			issue(
				typeof current.message === 'string' && current.message.trim()
					? current.message
					: 'Invalid value',
				{
					...(path?.length ? { path } : {}),
					...(typeof current.type === 'number' ? { code: String(current.type) } : {}),
				},
			),
		)
	}
	return out.length > 0 ? out : [issue('Invalid value')]
}

const cloneValue = <T>(value: T): T => {
	if (Array.isArray(value)) return value.map((entry) => cloneValue(entry)) as T
	if (!value || typeof value !== 'object') return value
	const out = Object.create(Object.getPrototypeOf(value))
	for (const key of Reflect.ownKeys(value)) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key)
		if (!descriptor) continue
		if ('value' in descriptor) descriptor.value = cloneValue(descriptor.value)
		Object.defineProperty(out, key, descriptor)
	}
	return out
}

const normalizeStrictObjects = <T>(value: T): T => {
	if (Array.isArray(value)) return value.map((entry) => normalizeStrictObjects(entry)) as T
	if (!value || typeof value !== 'object') return value

	const out = Object.create(Object.getPrototypeOf(value))
	const current = value as Record<PropertyKey, unknown>
	for (const key of Reflect.ownKeys(current)) {
		const descriptor = Object.getOwnPropertyDescriptor(current, key)
		if (!descriptor) continue
		if ('value' in descriptor) descriptor.value = normalizeStrictObjects(descriptor.value)
		Object.defineProperty(out, key, descriptor)
	}

	const next = out as Record<PropertyKey, unknown>
	if (
		next.type === 'object' &&
		next.properties &&
		typeof next.properties === 'object' &&
		next.additionalProperties === undefined
	) {
		next.additionalProperties = false
	}

	return out
}

export const toJsonSchema = (schema: Schema): Record<string, unknown> => {
	const cached = NORMALIZED_SCHEMA_CACHE.get(schema as object)
	if (cached) return cloneValue(cached)
	const normalized = normalizeStrictObjects(cloneValue(schema)) as Record<string, unknown>
	NORMALIZED_SCHEMA_CACHE.set(schema as object, normalized)
	return cloneValue(normalized)
}

export type JsonValidationOk<T> = { ok: true; value: T }
export type JsonValidationErr = { ok: false; issues: ValidationIssue[] }
export type JsonValidationResult<T> = JsonValidationOk<T> | JsonValidationErr
export type JsonValidator<T> = (value: unknown) => JsonValidationResult<T>

export const compileValidator = <S extends Schema>(schema: S): JsonValidator<Infer<S>> => {
	const cached = TYPECHECK_CACHE.get(schema as object) as TypeCheck<S> | undefined
	const normalized =
		NORMALIZED_SCHEMA_CACHE.get(schema as object) ??
		(normalizeStrictObjects(cloneValue(schema)) as Record<string, unknown>)
	if (!NORMALIZED_SCHEMA_CACHE.has(schema as object)) {
		NORMALIZED_SCHEMA_CACHE.set(schema as object, normalized)
	}
	const compiled = cached ?? TypeCompiler.Compile(normalized as S)
	if (!cached) TYPECHECK_CACHE.set(schema as object, compiled as TypeCheck<any>)

	return (value: unknown) => {
		const candidate = Value.Default(normalized as S, Value.Clone(value))
		const ok = compiled.Check(candidate)
		return ok
			? { ok: true as const, value: candidate as Infer<S> }
			: {
					ok: false as const,
					issues: issuesFromTypeBoxErrors(compiled.Errors(candidate) as Iterable<ValueError>),
				}
	}
}
