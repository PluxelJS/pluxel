import { describe, expect, it } from 'vitest'
import * as v from 'valibot'
import { arrayMeta, formMeta, picklistMeta } from 'valibot-form'
import { compileConfigPresentationPlanV1 } from '../../src/api/presenters/configPresentation'
import type { ConfigPresentationFieldV1 } from '../../src/web/protocol'
import { parseConfigPresentationPlanV1, parseRuntimePortableData } from '../../src/web/validation'
import {
	adaptConfigPresentationFields,
	buildEditableConfigPatch,
} from '../../../workbench-app/src/app/plugins/config/presentationAdapter'

const baseField = (path: string): ConfigPresentationFieldV1 => ({
	kind: 'string',
	name: path,
	path,
	depth: 0,
	meta: { label: path },
	required: true,
	control: 'text',
})

const plan = (overrides: Record<string, unknown> = {}) => ({
	version: 1,
	fieldName: 'config',
	defaults: {},
	fields: [baseField('value')],
	sections: [],
	...overrides,
})

describe('ConfigPresentationPlanV1 compiler', () => {
	it('projects supported schema kinds into closed portable DTOs', () => {
		const schema = v.object({
			title: v.string(),
			count: v.number(),
			enabled: v.boolean(),
			mode: v.pipe(v.picklist(['safe', 'fast']), picklistMeta({ control: 'segmented' })),
			items: v.array(v.string()),
			lookup: v.record(v.string(), v.number()),
			nested: v.object({ value: v.string() }),
			variant: v.union([
				v.object({ type: v.literal('text'), value: v.string() }),
				v.object({ type: v.literal('count'), value: v.number() }),
			]),
		})
		const output = compileConfigPresentationPlanV1({
			fieldName: 'config',
			schema,
			defaults: { title: '', enabled: false, items: [], lookup: {} },
			sections: [],
		})

		expect(output.fields.map((field) => field.kind)).toEqual([
			'string',
			'number',
			'boolean',
			'picklist',
			'array',
			'record',
			'object',
			'union',
		])
		expect(output.fields.find((field) => field.kind === 'union')).toMatchObject({
			kind: 'union',
			discriminator: 'type',
			branches: [{ discriminatorValue: 'text' }, { discriminatorValue: 'count' }],
		})
		expect(() => JSON.stringify(output)).not.toThrow()
		expect(parseRuntimePortableData(output)).toEqual(output)
	})

	it('turns unsupported schemas and non-portable renderer defaults into read-only fields', () => {
		const schema = v.object({
			createdAt: v.pipe(v.date(), formMeta({ label: 'Created at' })),
			items: v.pipe(v.array(v.string()), arrayMeta({ defaultItem: () => 'not portable' })),
		})
		const output = compileConfigPresentationPlanV1({
			fieldName: 'config',
			schema,
			defaults: {},
			sections: [],
		})

		for (const field of output.fields) {
			expect(field).toMatchObject({
				kind: 'unsupported',
				readOnly: true,
				meta: { readOnly: true },
			})
		}
		expect(
			output.fields
				.filter((field) => field.kind === 'unsupported')
				.every((field) => field.reason.length > 0),
		).toBe(true)
	})

	it('represents an opaque Standard Schema without sending executable schema state', () => {
		const output = compileConfigPresentationPlanV1({
			fieldName: 'config',
			schema: {
				'~standard': {
					version: 1,
					vendor: 'fixture',
					validate: () => ({ value: {} }),
				},
			},
			defaults: {},
			sections: [],
		})

		expect(output.fields).toEqual([
			expect.objectContaining({ kind: 'unsupported', readOnly: true }),
		])
		expect(JSON.stringify(output)).not.toContain('validate')
	})
})

describe('ConfigPresentationPlanV1 validation', () => {
	it('deeply freezes cloned portable data and rejects executable or realm-specific values', () => {
		const parsed = parseRuntimePortableData({ values: ['safe'] }) as {
			readonly values: readonly string[]
		}
		expect(Object.isFrozen(parsed)).toBe(true)
		expect(Object.isFrozen(parsed.values)).toBe(true)
		expect(() => parseRuntimePortableData({ callback: () => undefined })).toThrow(/portable data/)
		expect(() => parseRuntimePortableData({ date: new Date() })).toThrow(/plain object/)
		expect(() => parseRuntimePortableData({ missing: undefined })).toThrow(/portable data/)
		const accessor = Object.defineProperty({}, 'value', { get: () => 'unsafe' })
		expect(() => parseRuntimePortableData(accessor)).toThrow(/data property/)
	})

	it('rejects unknown protocol fields and dangerous field or section paths', () => {
		expect(() =>
			parseConfigPresentationPlanV1(plan({ fields: [{ ...baseField('value'), depth: 1 }] })),
		).toThrow(/traversal depth/)
		expect(() =>
			parseConfigPresentationPlanV1(
				plan({ fields: [{ ...baseField('value'), source: 'schema source' }] }),
			),
		).toThrow(/unsupported field source/)
		expect(() =>
			parseConfigPresentationPlanV1(plan({ fields: [{ ...baseField('__proto__.polluted') }] })),
		).toThrow(/reserved/)
		expect(() =>
			parseConfigPresentationPlanV1(
				plan({
					sections: [
						{ path: ['safe', 'constructor'], fieldName: 'nested', defaults: {}, fields: [] },
					],
				}),
			),
		).toThrow(/reserved/)
		expect(() =>
			parseConfigPresentationPlanV1(
				plan({
					sections: [{ path: ['x'.repeat(129)], fieldName: 'nested', defaults: {}, fields: [] }],
				}),
			),
		).toThrow(/128 characters/)
	})

	it('requires unsupported fields to be explicitly and transitively read-only', () => {
		const unsupported = {
			kind: 'unsupported',
			name: 'opaque',
			path: 'opaque',
			depth: 0,
			meta: { label: 'Opaque', readOnly: true },
			required: false,
			readOnly: true,
			reason: 'No portable control',
		}
		expect(parseConfigPresentationPlanV1(plan({ fields: [unsupported] })).fields).toEqual([
			unsupported,
		])
		expect(() =>
			parseConfigPresentationPlanV1(
				plan({ fields: [{ ...unsupported, meta: { label: 'Opaque' } }] }),
			),
		).toThrow(/read-only/)
	})

	it('enforces nesting, aggregate node, and aggregate text budgets', () => {
		let nested: ConfigPresentationFieldV1 = baseField('leaf')
		for (let depth = 0; depth < 34; depth++) {
			nested = {
				kind: 'object',
				name: `level${depth}`,
				path: `level${depth}`,
				depth,
				meta: { label: `Level ${depth}` },
				required: true,
				fields: [nested],
			}
		}
		expect(() => parseConfigPresentationPlanV1(plan({ fields: [nested] }))).toThrow(
			/maximum nesting depth/,
		)

		const manyFields = Array.from({ length: 7_000 }, (_, index) => baseField(`field${index}`))
		expect(() => parseConfigPresentationPlanV1(plan({ fields: manyFields }))).toThrow(
			/total node budget/,
		)

		const largeText = 'x'.repeat(900_000)
		expect(() =>
			parseConfigPresentationPlanV1(
				plan({
					defaults: { a: largeText, b: largeText, c: largeText, d: largeText, e: largeText },
				}),
			),
		).toThrow(/total text budget/)
	})
})

describe('Workbench presentation adapter', () => {
	it('never emits unsupported values in an editable patch and preserves nested server values', () => {
		const unsupported: ConfigPresentationFieldV1 = {
			kind: 'unsupported',
			name: 'opaque',
			path: 'opaque',
			depth: 0,
			meta: { label: 'Opaque', readOnly: true },
			required: false,
			readOnly: true,
			reason: 'Server-only type',
		}
		const object: ConfigPresentationFieldV1 = {
			kind: 'object',
			name: 'nested',
			path: 'nested',
			depth: 0,
			meta: { label: 'Nested' },
			required: true,
			fields: [
				{ ...baseField('nested.name'), name: 'name', depth: 1 },
				{ ...unsupported, name: 'secret', path: 'nested.secret', depth: 1 },
			],
		}
		const unsafeArray: ConfigPresentationFieldV1 = {
			kind: 'array',
			name: 'opaqueList',
			path: 'opaqueList',
			depth: 0,
			meta: { label: 'Opaque list' },
			required: true,
			item: { ...unsupported, name: 'item', path: 'opaqueList[]', depth: 1 },
		}
		const fields = adaptConfigPresentationFields([
			baseField('title'),
			unsupported,
			object,
			unsafeArray,
		])
		const patch = buildEditableConfigPatch(
			fields,
			{
				title: 'changed',
				opaque: 'browser mutation',
				nested: { name: 'changed', secret: 'browser mutation' },
				opaqueList: ['browser mutation'],
			},
			{
				title: 'saved',
				opaque: 'server value',
				nested: { name: 'saved', secret: 'server value' },
				opaqueList: ['server value'],
			},
		)

		expect(patch).toEqual({
			title: 'changed',
			nested: { name: 'changed', secret: 'server value' },
		})
		expect(fields.find((field) => field.name === 'opaqueList')?.meta.readOnly).toBe(true)
	})
})
