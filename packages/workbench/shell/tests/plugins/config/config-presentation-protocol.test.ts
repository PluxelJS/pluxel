import { describe, expect, it } from 'vitest'
import { serialize } from 'capnweb'
import type { FieldNode } from 'valibot-form'
import {
	parseConfigPresentationPlanV3,
	parseRuntimePortableData,
} from '@pluxel/services/management/client'
import { applyConfigSources } from '../../../src/app/plugins/config/presentationAdapter'
import { buildEditableConfigPatch, prepareEditableConfigFields } from 'valibot-form/web'

const fieldBase = (path: string) => ({
	name: path,
	path,
	depth: 0,
	meta: { label: path },
	required: true,
	nullable: false,
})

const baseField = (path: string) =>
	({
		...fieldBase(path),
		kind: 'string',
		control: 'text',
	}) satisfies FieldNode

const plan = (section: Record<string, unknown> = {}) => ({
	version: 3,
	sections: [{ path: [], fieldName: 'config', fields: [baseField('value')], ...section }],
})

describe('ConfigPresentationPlanV3 validation', () => {
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

	it('checks version and declaration paths before accepting common fields', () => {
		expect(() => parseConfigPresentationPlanV3({ ...plan(), version: 2 })).toThrow(
			'plan.version must be 3',
		)
		expect(() => parseConfigPresentationPlanV3({ ...plan(), fields: [] })).toThrow(
			'plan contains unsupported field fields',
		)
		expect(() =>
			parseConfigPresentationPlanV3(plan({ fields: [{ ...baseField('value'), depth: 1 }] })),
		).toThrow(/sections\[0\].fields.*depth/)
		expect(() =>
			parseConfigPresentationPlanV3(
				plan({ fields: [{ ...baseField('value'), source: 'schema source' }] }),
			),
		).toThrow(/sections\[0\].fields.*source/)
		expect(() => parseConfigPresentationPlanV3(plan({ path: ['safe', 'constructor'] }))).toThrow(
			/reserved/,
		)
		expect(() => parseConfigPresentationPlanV3(plan({ path: ['x'.repeat(129)] }))).toThrow(
			/128 characters/,
		)
		const duplicate = plan()
		expect(() =>
			parseConfigPresentationPlanV3({
				...duplicate,
				sections: [...duplicate.sections, ...duplicate.sections],
			}),
		).toThrow('plan.sections[1].path duplicates a declaration section')
	})

	it('reads field diagnostic text without interpreting it as a registration name', () => {
		const field = { ...baseField('value'), path: '__proto__.polluted' }
		const parsed = parseConfigPresentationPlanV3(plan({ fields: [field] }))
		expect(parsed.sections[0]?.fields[0]).toEqual(field)
		expect(Object.isFrozen(parsed.sections[0]?.fields[0]?.meta)).toBe(true)
		expect(
			parseConfigPresentationPlanV3(plan({ path: ['literal.part '] })).sections[0]?.path,
		).toEqual(['literal.part '])
	})

	it('enforces nesting, aggregate node, and aggregate text budgets', () => {
		let nested: FieldNode = baseField('leaf')
		for (let depth = 0; depth < 34; depth++) {
			nested = {
				kind: 'object',
				name: `level${depth}`,
				path: `level${depth}`,
				depth,
				meta: { label: `Level ${depth}` },
				required: true,
				nullable: false,
				fields: [nested],
			}
		}
		expect(() => parseConfigPresentationPlanV3(plan({ fields: [nested] }))).toThrow(
			/maximum nesting depth/,
		)

		const manyFields = Array.from({ length: 7_000 }, (_, index) => baseField(`field${index}`))
		expect(() => parseConfigPresentationPlanV3(plan({ fields: manyFields }))).toThrow(
			/total node budget/,
		)

		const largeText = 'x'.repeat(900_000)
		expect(() =>
			parseConfigPresentationPlanV3(
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

describe('Workbench config draft from shared fields', () => {
	it('emits only editable nested paths so the server deep merge preserves unsupported values', () => {
		const unsupported: FieldNode = {
			kind: 'unsupported',
			name: 'opaque',
			path: 'opaque',
			depth: 0,
			meta: { label: 'Opaque', readOnly: true },
			required: false,
			nullable: false,
			readOnly: true,
			reason: 'Server-only type',
		}
		const object: FieldNode = {
			kind: 'object',
			name: 'nested',
			path: 'nested',
			depth: 0,
			meta: { label: 'Nested' },
			required: true,
			nullable: false,
			fields: [
				{ ...baseField('nested.name'), name: 'name', depth: 1 },
				{ ...unsupported, name: 'secret', path: 'nested.secret', depth: 1 },
			],
		}
		const unsafeArray: FieldNode = {
			kind: 'array',
			name: 'opaqueList',
			path: 'opaqueList',
			depth: 0,
			meta: { label: 'Opaque list' },
			required: true,
			nullable: false,
			item: { ...unsupported, name: 'item', path: 'opaqueList[]', depth: 1 },
		}
		const fields = parseConfigPresentationPlanV3(
			plan({ fields: [baseField('title'), unsupported, object, unsafeArray] }),
		).sections[0]!.fields
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
		})
		expect(
			prepareEditableConfigFields(fields, {}).find((field) => field.name === 'opaqueList'),
		).toMatchObject({
			kind: 'unsupported',
			meta: { readOnly: true },
		})
		// capnweb refuses null-prototype objects ("Cannot serialize value"), so a patch must be plain.
		expect(Object.getPrototypeOf(patch)).toBe(Object.prototype)
		expect(Object.getPrototypeOf(patch.set)).toBe(Object.prototype)
		expect(Object.getPrototypeOf(patch.set?.nested)).toBe(Object.prototype)
	})
})

it('explains effective env sources on nested fields while preserving editable siblings in the patch', () => {
	const fields = applyConfigSources(
		[
			{
				kind: 'object',
				name: 'nested',
				path: 'nested',
				depth: 0,
				meta: { label: 'Value' },
				required: true,
				nullable: false,
				fields: [
					{ ...baseField('nested.locked'), name: 'locked', depth: 1 },
					{ ...baseField('nested.free'), name: 'free', depth: 1 },
				],
			},
		],
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
	).toEqual({ set: { nested: { free: 'edit' } } })
})

it('keeps the field description punctuation when appending config hints', () => {
	const [field] = applyConfigSources(
		[
			{
				...fieldBase('limit'),
				kind: 'number',
				placeholder: '例如 100',
				meta: { label: 'Limit', description: '上限。' },
			},
		],
		[],
		[],
		{},
		{ limit: 500 },
	)
	expect(field).toMatchObject({
		placeholder: '例如 100',
		meta: { description: '上限。目标配置：500' },
	})
})

it('shows defaults in empty input controls while keeping explicit input and other target hints', () => {
	const theme = {
		...fieldBase('theme'),
		kind: 'picklist',
		control: 'select',
		options: ['nord', 'sand'],
		labels: { nord: 'Nord', sand: 'Sand' },
	} as const
	const [limit, color, radio, path, saved, password] = applyConfigSources(
		[
			{ ...fieldBase('limit'), kind: 'number', meta: { label: 'Limit', description: '上限。' } },
			theme,
			{ ...theme, name: 'radio', path: 'radio', control: 'radio' },
			baseField('path'),
			{ ...fieldBase('saved'), kind: 'number' },
			{ ...baseField('password'), kind: 'string', control: 'password' },
		],
		[],
		[],
		{ saved: 3 },
		{ limit: 0, theme: 'nord', radio: 'nord', path: '/health', saved: 3, password: 'example' },
	)
	expect(limit).toMatchObject({ placeholder: '0', meta: { description: '上限。' } })
	expect(color).toMatchObject({ placeholder: 'Nord' })
	expect(color?.meta.description).toBeUndefined()
	expect(radio).not.toHaveProperty('placeholder')
	expect(radio?.meta.description).toBe('目标配置："nord"')
	expect(path).toMatchObject({ placeholder: '/health' })
	expect(saved).not.toHaveProperty('placeholder')
	expect(saved?.meta.description).toBe('当前有效输入：3。目标配置：3')
	expect(password).not.toHaveProperty('placeholder')
	expect(password?.meta.description).toBeUndefined()
})
