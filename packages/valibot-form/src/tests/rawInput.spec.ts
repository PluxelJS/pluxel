import { describe, expect, expectTypeOf, it } from 'vitest'
import * as v from 'valibot'
import {
	formMeta,
	projectRawInput,
	type RawInputProjection,
	type RawInputProjectionFailure,
	type RawInputProjectionResult,
} from '../core'

describe('projectRawInput', () => {
	it('derives the four transports from raw scalar and compound inputs', () => {
		const schema = v.object({
			text: v.string(),
			count: v.number(),
			enabled: v.boolean(),
			items: v.array(v.string()),
			settings: v.object({ nested: v.string() }),
		})

		expect(projectRawInput(schema, ['text'])).toMatchObject({ ok: true, transport: 'string' })
		expect(projectRawInput(schema, ['count'])).toMatchObject({ ok: true, transport: 'number' })
		expect(projectRawInput(schema, ['enabled'])).toMatchObject({
			ok: true,
			transport: 'boolean',
		})
		expect(projectRawInput(schema, ['items'])).toMatchObject({ ok: true, transport: 'json' })
		expect(projectRawInput(schema, ['settings'])).toMatchObject({
			ok: true,
			transport: 'json',
			expectsPlainObject: true,
		})
	})

	it('projects pre-transform format and numeric constraints', () => {
		const schema = v.object({
			endpointLength: v.pipe(
				v.string(),
				v.url(),
				formMeta({ description: 'Public callback URL.' }),
				v.transform((value) => value.length),
				v.minValue(10),
			),
			port: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(65_535), v.multipleOf(2)),
		})

		expect(projectRawInput(schema, ['endpointLength'])).toEqual({
			ok: true,
			path: ['endpointLength'],
			transport: 'string',
			inputKind: 'string',
			inputDescription: 'string (URL)',
			descriptions: ['Public callback URL.'],
			format: 'URL',
			expectsPlainObject: false,
		})
		expect(projectRawInput(schema, ['port'])).toMatchObject({
			ok: true,
			transport: 'number',
			inputDescription: 'number (finite integer, >= 1, <= 65535, multiple of 2)',
			range: {
				finite: true,
				integer: true,
				minimum: 1,
				maximum: 65_535,
				multipleOf: 2,
			},
		})
	})

	it('stops collecting facts at transforms across nested pipes', () => {
		const normalized = v.pipe(
			v.string(),
			v.url(),
			v.transform((value) => value.toUpperCase()),
		)
		const schema = v.pipe(normalized, v.minLength(100))

		expect(projectRawInput(schema)).toEqual({
			ok: true,
			path: [],
			transport: 'string',
			inputKind: 'string',
			inputDescription: 'string (URL)',
			descriptions: ['root'],
			format: 'URL',
			expectsPlainObject: false,
		})
	})

	it('uses optional raw input, nullable JSON, and null-rejecting wrapper semantics', () => {
		const schema = v.object({
			optionalCount: v.optional(v.number(), 10),
			nullableText: v.nullable(v.string()),
			nonNullableText: v.nonNullable(v.nullable(v.string())),
			nonNullishCount: v.nonNullish(v.nullish(v.number())),
			nested: v.optional(
				v.nullable(
					v.object({
						name: v.pipe(v.string(), v.title('Nested name')),
					}),
				),
			),
		})

		expect(projectRawInput(schema, ['optionalCount'])).toMatchObject({
			ok: true,
			transport: 'number',
		})
		expect(projectRawInput(schema, ['nullableText'])).toMatchObject({
			ok: true,
			transport: 'json',
			inputKind: 'union',
			inputDescription: 'JSON (string or null)',
		})
		expect(projectRawInput(schema, ['nonNullableText'])).toMatchObject({
			ok: true,
			transport: 'string',
			inputKind: 'string',
		})
		expect(projectRawInput(schema, ['nonNullishCount'])).toMatchObject({
			ok: true,
			transport: 'number',
			inputKind: 'number',
		})
		expect(projectRawInput(schema, ['nested', 'name'])).toMatchObject({
			ok: true,
			transport: 'string',
			descriptions: ['Nested name'],
		})
	})

	it('merges same-kind choices and uses JSON for mixed unions', () => {
		const schema = v.object({
			mode: v.union([v.literal('safe'), v.literal('fast')]),
			level: v.picklist([1, 2, 3]),
			mixed: v.union([v.string(), v.number()]),
		})

		expect(projectRawInput(schema, ['mode'])).toMatchObject({
			ok: true,
			transport: 'string',
			choices: ['safe', 'fast'],
		})
		expect(projectRawInput(schema, ['level'])).toMatchObject({
			ok: true,
			transport: 'number',
			choices: [1, 2, 3],
		})
		expect(projectRawInput(schema, ['mixed'])).toMatchObject({
			ok: true,
			transport: 'json',
			inputKind: 'union',
		})
	})

	it('resolves paths shared by present union branches while ignoring nullish branches', () => {
		const schema = v.union([
			v.object({ nested: v.pipe(v.string(), v.title('Nested value')) }),
			v.null(),
			v.undefined(),
		])

		expect(projectRawInput(schema, ['nested'])).toMatchObject({
			ok: true,
			transport: 'string',
			descriptions: ['Nested value'],
		})
	})

	it('describes compound JSON inputs without requiring all nested leaves to be projectable', () => {
		const schema = v.object({
			origins: v.array(v.pipe(v.string(), v.url())),
			opaque: v.array(v.unknown()),
			tuple: v.tuple([v.string(), v.number()]),
			lookup: v.record(v.string(), v.boolean()),
		})

		expect(projectRawInput(schema, ['origins'])).toMatchObject({
			ok: true,
			inputDescription: 'JSON array<string (URL)>',
		})
		expect(projectRawInput(schema, ['opaque'])).toMatchObject({
			ok: true,
			inputDescription: 'JSON array',
		})
		expect(projectRawInput(schema, ['tuple'])).toMatchObject({
			ok: true,
			inputDescription: 'JSON [string, number (finite)]',
		})
		expect(projectRawInput(schema, ['lookup'])).toMatchObject({
			ok: true,
			inputDescription: 'JSON object<string, boolean (true or false)>',
			expectsPlainObject: true,
		})
	})

	it('degrades compound descriptions instead of dropping unsupported tuple positions', () => {
		const schema = v.object({
			tuple: v.tuple([v.string(), v.unknown(), v.number()]),
			loose: v.looseTuple([v.string()]),
		})

		expect(projectRawInput(schema, ['tuple'])).toMatchObject({
			ok: true,
			transport: 'json',
			inputKind: 'tuple',
			inputDescription: 'JSON array',
		})
		expect(projectRawInput(schema, ['loose'])).toMatchObject({
			ok: true,
			inputDescription: 'JSON [string, ...unknown[]]',
		})
	})

	it('looks through raw object pipes and object intersections', () => {
		const schema = v.pipe(
			v.intersect([
				v.object({ first: v.string() }),
				v.object({ nested: v.optional(v.object({ count: v.number() })) }),
			]),
			v.transform((value) => ({ ...value, transformed: true })),
		)

		expect(projectRawInput(schema, ['first'])).toMatchObject({ ok: true, transport: 'string' })
		expect(projectRawInput(schema, ['nested', 'count'])).toMatchObject({
			ok: true,
			transport: 'number',
		})
		expect(projectRawInput(schema)).toMatchObject({
			ok: true,
			transport: 'json',
			expectsPlainObject: true,
		})
	})

	it('aggregates union branch descriptions deterministically', () => {
		const schema = v.union([
			v.object({ value: v.pipe(v.string(), v.description('Zulu description')) }),
			v.object({ value: v.pipe(v.string(), v.title('Alpha label')) }),
			v.object({ value: v.pipe(v.string(), v.description('Zulu description')) }),
		])

		expect(projectRawInput(schema, ['value'])).toMatchObject({
			ok: true,
			transport: 'string',
			descriptions: ['Alpha label', 'Zulu description'],
		})
	})

	it('fails closed for missing, ambiguous, and unsupported paths', () => {
		const schema = v.object({
			any: v.any(),
			unknown: v.unknown(),
			custom: v.custom<unknown>(() => true),
			branch: v.union([
				v.object({ shared: v.string(), onlyA: v.string() }),
				v.object({ shared: v.string(), onlyB: v.string() }),
			]),
			record: v.record(v.string(), v.object({ nested: v.string() })),
		})

		expect(projectRawInput(schema, ['missing'])).toMatchObject({
			ok: false,
			kind: 'path_not_found',
		})
		expect(projectRawInput(schema, ['unknown'])).toMatchObject({
			ok: false,
			kind: 'unsupported_schema',
			schemaType: 'unknown',
		})
		expect(projectRawInput(schema, ['any'])).toMatchObject({
			ok: false,
			kind: 'unsupported_schema',
			schemaType: 'any',
		})
		expect(projectRawInput(schema, ['custom'])).toMatchObject({
			ok: false,
			kind: 'unsupported_schema',
			schemaType: 'custom',
		})
		expect(projectRawInput(schema, ['branch', 'onlyA'])).toMatchObject({
			ok: false,
			kind: 'ambiguous_path',
		})
		expect(projectRawInput(schema, ['record', 'nested'])).toMatchObject({
			ok: false,
			kind: 'path_not_found',
		})
	})

	it('never executes defaults, validation, transforms, or lazy getters', () => {
		let executions = 0
		const schema = v.object({
			value: v.optional(
				v.pipe(
					v.string(),
					v.check(() => {
						executions++
						return true
					}),
					v.transform((value) => {
						executions++
						return value.length
					}),
				),
				() => {
					executions++
					return 'default'
				},
			),
			lazy: v.lazy(() => {
				executions++
				return v.string()
			}),
		})

		expect(projectRawInput(schema, ['value'])).toMatchObject({ ok: true, transport: 'string' })
		expect(projectRawInput(schema, ['lazy'])).toMatchObject({
			ok: false,
			kind: 'unsupported_schema',
			schemaType: 'lazy',
		})
		expect(executions).toBe(0)
	})

	it('exposes a discriminated and readonly result contract', () => {
		const result: RawInputProjectionResult = projectRawInput(v.string())
		if (result.ok === true) {
			expectTypeOf(result).toEqualTypeOf<RawInputProjection>()
			expectTypeOf(result.transport).toEqualTypeOf<'string' | 'number' | 'boolean' | 'json'>()
		} else if (result.ok === false) {
			expectTypeOf(result).toEqualTypeOf<RawInputProjectionFailure>()
		}
		expectTypeOf<
			Extract<RawInputProjectionResult, { ok: false }>
		>().toEqualTypeOf<RawInputProjectionFailure>()
		expect(Object.isFrozen(result)).toBe(true)
		expect(Object.isFrozen(result.path)).toBe(true)
	})
})
