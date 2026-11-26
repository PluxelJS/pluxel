import { parseWorkbenchContentPlan, type WorkbenchContentPlan } from '@pluxel/core/internal'
import { workbench } from '@pluxel/workbench'
import { arrayMeta, formMeta, picklistMeta, stringMeta } from 'valibot-form'
import * as v from 'valibot'
import { describe, expect, it, vi } from 'vitest'
import {
	prepareWorkbenchContentContract,
	validateWorkbenchContentBinding,
} from '@pluxel/workbench/internal'

type ContentSlot = WorkbenchContentPlan['slots'][number]

function plan(slots: readonly ContentSlot[]): WorkbenchContentPlan {
	return parseWorkbenchContentPlan({
		version: 1,
		kind: 'workbench-content',
		document: {
			version: 1,
			blocks: slots.map((slot) =>
				slot.display === 'inline'
					? { type: 'paragraph', children: [{ type: 'slot', key: slot.key }] }
					: { type: 'slot', key: slot.key },
			),
		},
		slots,
	})
}

describe('Workbench Content presentation boundary', () => {
	it('fails publication for unsupported action fields', () => {
		const slots = {
			submit: workbench.action({
				label: 'Submit',
				input: v.object({ detail: v.optional(v.object({ createdAt: v.date() })) }),
			}),
		}
		const artifact = plan([
			{
				kind: 'action',
				key: 'submit',
				display: 'block',
				label: 'Submit',
				input: 'dialog',
			},
		])

		expect(() => prepareWorkbenchContentContract(slots, artifact)).toThrow(
			'Content action slot submit has an unsupported form field at detail.createdAt',
		)
	})

	it.each([
		[v.strictObject({ mode: v.literal('fixed') }), 'mode'],
		[
			v.strictObject({
				nested: v.object({ token: v.pipe(v.string(), formMeta({ hidden: true })) }),
			}),
			'nested.token',
		],
		[v.strictObject({ '0': v.string() }), '0'],
		[
			v.strictObject({
				items: v.pipe(v.array(v.string()), v.minLength(1), arrayMeta({ addable: false })),
			}),
			'items',
		],
		[
			v.strictObject({
				role: v.pipe(
					v.picklist(['reader', 'editor']),
					picklistMeta({ disabled: ['reader'], entries: [{ value: 'editor', disabled: true }] }),
				),
			}),
			'role',
		],
		[v.strictObject({ role: v.picklist([]) }), 'role'],
		[
			v.object({
				levels: v.pipe(
					v.array(v.picklist([1, '1'])),
					v.minLength(3),
					arrayMeta({ layout: 'picker' }),
				),
			}),
			'levels',
		],
	] as const)('rejects required fields without a value source', (input, path) => {
		const slots = { submit: workbench.action({ label: 'Submit', input }) }
		const artifact = plan([
			{ kind: 'action', key: 'submit', display: 'block', label: 'Submit', input: 'dialog' },
		])
		expect(() => prepareWorkbenchContentContract(slots, artifact)).toThrow(
			`Content action slot submit cannot fill required field at ${path} from an empty draft`,
		)
	})

	it('accepts selectable discriminators and optional protected inputs without evaluating defaults', () => {
		const defaultMode = vi.fn(() => 'fixed' as const)
		const input = v.strictObject({
			destination: v.variant('kind', [
				v.strictObject({ kind: v.literal('file'), path: v.string() }),
				v.strictObject({ kind: v.literal('queue'), topic: v.string() }),
			]),
			mode: v.optional(v.literal('fixed'), defaultMode),
			empty: v.strictObject({}),
			tags: v.pipe(v.array(v.string()), arrayMeta({ addable: false })),
			role: v.pipe(
				v.picklist(['reader']),
				picklistMeta({ disabled: ['reader'], entries: [{ value: 'reader', disabled: false }] }),
			),
		})
		const slots = { submit: workbench.action({ label: 'Submit', input }) }
		const artifact = plan([
			{ kind: 'action', key: 'submit', display: 'block', label: 'Submit', input: 'dialog' },
		])
		const contract = prepareWorkbenchContentContract(slots, artifact)
		expect(contract.presentation.slots[0]).toMatchObject({
			fields: [
				{ kind: 'union', name: 'destination', discriminator: 'kind' },
				{ name: 'mode', required: false, meta: { readOnly: true } },
				{ kind: 'object', name: 'empty', fields: [] },
				{ kind: 'array', name: 'tags', addable: false },
				{ kind: 'picklist', name: 'role', options: ['reader'] },
			],
		})
		expect(defaultMode).not.toHaveBeenCalled()
	})

	it('checks the raw literal in a required row seed before publishing the action', () => {
		const mode = v.literal('fixed')
		const artifact = plan([
			{ kind: 'action', key: 'submit', display: 'block', label: 'Submit', input: 'dialog' },
		])
		const publish = (value: string) => {
			const input = v.object({
				rows: v.pipe(
					v.array(v.strictObject({ mode, title: v.string() })),
					v.minLength(1),
					arrayMeta({ defaultItem: { mode: value, title: '' } }),
				),
			})
			return prepareWorkbenchContentContract(
				{ submit: workbench.action({ label: 'Submit', input }) },
				artifact,
			)
		}
		expect(() => publish('other')).toThrow(
			/slot submit cannot fill required field at rows\[\]\.mode/,
		)
		expect(publish('fixed').presentation.slots).toHaveLength(1)
	})

	it('can publish a selector-supplied literal and a picklist with one enabled typed twin', () => {
		const input = v.object({
			metrics: v.union([v.literal(false), v.object({ path: v.string() })]),
			level: v.pipe(v.picklist([1, '1']), picklistMeta({ disabled: ['1'] })),
			levels: v.pipe(
				v.array(v.picklist([1, '1'])),
				v.minLength(2),
				arrayMeta({ layout: 'picker', addable: false }),
			),
		})
		const slots = { submit: workbench.action({ label: 'Submit', input }) }
		const artifact = plan([
			{ kind: 'action', key: 'submit', display: 'block', label: 'Submit', input: 'dialog' },
		])
		expect(prepareWorkbenchContentContract(slots, artifact).presentation.slots).toHaveLength(1)
	})

	it.each([
		[
			'transform',
			v.pipe(
				v.string(),
				v.transform((value) => value.length),
			),
			'must not transform display values',
		],
		['default', v.optional(v.string(), 'ready'), 'must not use defaults or lazy schemas'],
		['lazy', v.lazy(() => v.string()), 'must not use defaults or lazy schemas'],
		[
			'password',
			v.pipe(v.string(), stringMeta({ control: 'password' })),
			'must not display a password value',
		],
		[
			'transformed record key',
			v.record(
				v.pipe(
					v.string(),
					v.transform((key) => key.toLowerCase()),
				),
				v.string(),
			),
			'must not transform display values',
		],
	] as const)('rejects a %s data schema before publication', (_name, schema, message) => {
		const slots = {
			status: workbench.data(schema),
		}
		const artifact = plan([{ kind: 'data', key: 'status', display: 'block' }])

		expect(() => prepareWorkbenchContentContract(slots, artifact)).toThrow(message)
	})

	it('accepts nullable data without treating Valibot internal metadata as a default', () => {
		const slots = {
			status: workbench.data(v.object({ error: v.nullable(v.string()) })),
		}
		const contract = prepareWorkbenchContentContract(
			slots,
			plan([{ kind: 'data', key: 'status', display: 'block' }]),
		)

		expect(contract.presentation.slots).toHaveLength(1)
	})

	it('rejects artifact/declaration key, kind, and action metadata mismatches', () => {
		const dataArtifact = plan([{ kind: 'data', key: 'status', display: 'block' }])
		const wrongKey = {
			other: workbench.data(v.string()),
		}
		const wrongKind = {
			status: workbench.action({ label: 'Status' }),
		}
		const actionArtifact = plan([
			{
				kind: 'action',
				key: 'refresh',
				display: 'block',
				label: 'Artifact label',
				input: 'none',
			},
		])
		const wrongMetadata = {
			refresh: workbench.action({ label: 'Declaration label' }),
		}

		expect(() => prepareWorkbenchContentContract(wrongKey, dataArtifact)).toThrow(
			'slots do not match the committed artifact',
		)
		expect(() => prepareWorkbenchContentContract(wrongKind, dataArtifact)).toThrow(
			'slot status does not match the committed artifact',
		)
		expect(() => prepareWorkbenchContentContract(wrongMetadata, actionArtifact)).toThrow(
			'slot refresh does not match the committed artifact',
		)
	})

	it('requires exact factory and action binding keys', () => {
		const slots = {
			refresh: workbench.action({ label: 'Refresh' }),
			status: workbench.data(v.object({ count: v.number() })),
		}
		const contract = prepareWorkbenchContentContract(
			slots,
			plan([
				{
					kind: 'action',
					key: 'refresh',
					display: 'block',
					label: 'Refresh',
					input: 'none',
				},
				{ kind: 'data', key: 'status', display: 'block' },
			]),
		)
		const load = vi.fn()
		const refresh = vi.fn()

		expect(
			validateWorkbenchContentBinding(contract, {
				load,
				actions: { refresh },
			}),
		).toMatchObject({ load, actions: expect.any(Map) })
		const subscribe = vi.fn(() => ({ [Symbol.dispose]: vi.fn() }))
		expect(
			validateWorkbenchContentBinding(contract, { load, subscribe, actions: { refresh } }),
		).toMatchObject({ subscribe })
		expect(subscribe).not.toHaveBeenCalled()
		expect(() =>
			validateWorkbenchContentBinding(contract, {
				load,
				subscribe: undefined,
				actions: { refresh },
			}),
		).toThrow('subscribe must be a function')
		expect(() =>
			validateWorkbenchContentBinding(
				{ ...contract, data: new Map() },
				{ subscribe, actions: { refresh } },
			),
		).toThrow('must contain exactly actions')
		expect(() =>
			validateWorkbenchContentBinding(contract, {
				load,
				actions: { refresh },
				extra: true,
			}),
		).toThrow('must contain exactly actions, load')
		expect(() =>
			validateWorkbenchContentBinding(contract, {
				load,
				actions: {},
			}),
		).toThrow('must exactly match its action slots')
		expect(() =>
			validateWorkbenchContentBinding(contract, {
				load,
				actions: { refresh, extra: vi.fn() },
			}),
		).toThrow('must exactly match its action slots')
	})
})
