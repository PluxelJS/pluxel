import { describe, expect, it } from 'vitest'
import * as v from 'valibot'
import { arrayMeta, formMeta, picklistMeta } from 'valibot-form'
import { serialize } from 'capnweb'
import type { ConfigPresentationFieldV1 } from '@pluxel/services/management/protocol'
import {
	compileConfigPresentationPlanV2,
	parseConfigPresentationPlanV2,
	parseRuntimePortableData,
} from '@pluxel/services/management/internal'
import {
	adaptConfigPresentationFields,
	buildEditableConfigPatch,
	applyConfigSources,
} from '../../src/app/plugins/config/presentationAdapter'

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
	version: 2,
	fieldName: 'config',
	fields: [baseField('value')],
	sections: [],
	...overrides,
})

describe('ConfigPresentationPlanV2 compiler', () => {
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
		const output = compileConfigPresentationPlanV2({
			fieldName: 'config',
			schema,
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
		expect(() => serialize(output)).not.toThrow()
		expect(parseRuntimePortableData(output)).toEqual(output)
	})

	it('turns unsupported schemas and non-portable renderer defaults into read-only fields', () => {
		const schema = v.object({
			createdAt: v.pipe(v.date(), formMeta({ title: 'Created at' })),
			items: v.pipe(v.array(v.string()), arrayMeta({ defaultItem: () => 'not portable' })),
		})
		const output = compileConfigPresentationPlanV2({
			fieldName: 'config',
			schema,
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
		const output = compileConfigPresentationPlanV2({
			fieldName: 'config',
			schema: {
				'~standard': {
					version: 1,
					vendor: 'fixture',
					validate: () => ({ value: {} }),
				},
			},
			sections: [],
		})

		expect(output.fields).toEqual([
			expect.objectContaining({ kind: 'unsupported', readOnly: true }),
		])
		expect(JSON.stringify(output)).not.toContain('validate')
	})
})

describe('ConfigPresentationPlanV2 validation', () => {
	it('deeply freezes cloned portable data and rejects executable or realm-specific values', () => {
		const parsed = parseRuntimePortableData({ values: ['safe'] }) as {
			readonly values: readonly string[]
		}
		expect(Object.isFrozen(parsed)).toBe(true)
		expect(Object.isFrozen(parsed.values)).toBe(true)
		expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype)
		expect(() => serialize(parsed)).not.toThrow()
		const nullPrototypeInput = Object.assign(Object.create(null), {
			nested: Object.assign(Object.create(null), { value: 'safe' }),
		})
		const normalized = parseRuntimePortableData(nullPrototypeInput) as {
			readonly nested: Readonly<{ value: string }>
		}
		expect(Object.getPrototypeOf(normalized)).toBe(Object.prototype)
		expect(Object.getPrototypeOf(normalized.nested)).toBe(Object.prototype)
		expect(() => serialize(normalized)).not.toThrow()
		expect(() => parseRuntimePortableData({ callback: () => undefined })).toThrow(/portable data/)
		expect(() => parseRuntimePortableData({ date: new Date() })).toThrow(/plain object/)
		expect(() => parseRuntimePortableData({ missing: undefined })).toThrow(/portable data/)
		const accessor = Object.defineProperty({}, 'value', { get: () => 'unsafe' })
		expect(() => parseRuntimePortableData(accessor)).toThrow(/data property/)
	})

	it('rejects unknown protocol fields and dangerous field or section paths', () => {
		expect(() =>
			parseConfigPresentationPlanV2(plan({ fields: [{ ...baseField('value'), depth: 1 }] })),
		).toThrow(/traversal depth/)
		expect(() =>
			parseConfigPresentationPlanV2(
				plan({ fields: [{ ...baseField('value'), source: 'schema source' }] }),
			),
		).toThrow(/unsupported field source/)
		expect(() =>
			parseConfigPresentationPlanV2(plan({ fields: [{ ...baseField('__proto__.polluted') }] })),
		).toThrow(/reserved/)
		expect(() =>
			parseConfigPresentationPlanV2(
				plan({
					sections: [{ path: ['safe', 'constructor'], fieldName: 'nested', fields: [] }],
				}),
			),
		).toThrow(/reserved/)
		expect(() =>
			parseConfigPresentationPlanV2(
				plan({
					sections: [{ path: ['x'.repeat(129)], fieldName: 'nested', fields: [] }],
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
		expect(parseConfigPresentationPlanV2(plan({ fields: [unsupported] })).fields).toEqual([
			unsupported,
		])
		expect(() =>
			parseConfigPresentationPlanV2(
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
		expect(() => parseConfigPresentationPlanV2(plan({ fields: [nested] }))).toThrow(
			/maximum nesting depth/,
		)

		const manyFields = Array.from({ length: 7_000 }, (_, index) => baseField(`field${index}`))
		expect(() => parseConfigPresentationPlanV2(plan({ fields: manyFields }))).toThrow(
			/total node budget/,
		)

		const largeText = 'x'.repeat(900_000)
		expect(() =>
			parseConfigPresentationPlanV2(
				plan({
					fields: [
						{ ...baseField('a'), meta: { label: largeText, description: largeText } },
						{ ...baseField('b'), meta: { label: largeText, description: largeText } },
						{ ...baseField('c'), meta: { label: largeText } },
					],
				}),
			),
		).toThrow(/total text budget/)
	})
})

describe('Workbench presentation adapter', () => {
	it('emits only editable nested paths so the server deep merge preserves unsupported values', () => {
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
			set: { title: 'changed', nested: { name: 'changed' } },
			remove: [['title'], ['nested', 'name']],
		})
		expect(fields.find((field) => field.name === 'opaqueList')?.meta.readOnly).toBe(true)
	})
})

it('explains effective env sources on nested fields while preserving editable siblings in the patch', () => {
	const fields = applyConfigSources(
		adaptConfigPresentationFields([
			{
				kind: 'object',
				name: 'nested',
				path: 'nested',
				depth: 0,
				meta: { label: 'Value' },
				required: true,
				fields: [
					{ ...baseField('nested.locked'), name: 'locked', depth: 1 },
					{ ...baseField('nested.free'), name: 'free', depth: 1 },
				],
			},
		]),
		[
			{
				owner: {
					definition: {
						entry: { kind: 'package-root', packageName: '@test/owner' },
						exportName: 'Owner',
					},
					variant: 'default',
				},
				path: ['nested', 'locked'],
				kind: 'env',
				name: 'LOCKED_VALUE',
				readonly: true,
			},
		],
	)
	const object = fields[0]!
	if (object.kind !== 'object') throw new Error('Expected object')
	expect(object.meta.readOnly).not.toBe(true)
	expect(object.fields[0]?.meta.readOnly).not.toBe(true)
	expect(object.fields[0]?.meta.description).toContain('LOCKED_VALUE')
	expect(
		buildEditableConfigPatch(
			fields,
			{ nested: { locked: 'env', free: 'edit' } },
			{ nested: { locked: 'env', free: 'old' } },
		),
	).toEqual({ set: { nested: { free: 'edit' } }, remove: [['nested', 'free']] })
})
