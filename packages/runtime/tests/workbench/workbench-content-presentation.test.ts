import { parseWorkbenchContentPlan, type WorkbenchContentPlan } from '@pluxel/core/internal'
import { workbench } from '@pluxel/runtime/workbench'
import { stringMeta } from 'valibot-form'
import * as v from 'valibot'
import { describe, expect, it, vi } from 'vitest'
import {
	prepareWorkbenchContentContract,
	validateWorkbenchContentBinding,
} from '../../src/services/workbench/WorkbenchContentPresentation'

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
		const document = workbench.markdown(import.meta.url, './fixtures/action.md', {
			submit: workbench.action({
				label: 'Submit',
				input: v.object({ createdAt: v.date() }),
			}),
		})
		const artifact = plan([
			{
				kind: 'action',
				key: 'submit',
				display: 'block',
				label: 'Submit',
				input: 'dialog',
			},
		])

		expect(() => prepareWorkbenchContentContract(document, artifact)).toThrow(
			'unsupported form fields',
		)
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
	] as const)('rejects a %s data schema before publication', (_name, schema, message) => {
		const document = workbench.markdown(import.meta.url, './fixtures/data.md', {
			status: workbench.data(schema),
		})
		const artifact = plan([{ kind: 'data', key: 'status', display: 'block' }])

		expect(() => prepareWorkbenchContentContract(document, artifact)).toThrow(message)
	})

	it('accepts nullable data without treating Valibot internal metadata as a default', () => {
		const document = workbench.markdown(import.meta.url, './fixtures/data.md', {
			status: workbench.data(v.object({ error: v.nullable(v.string()) })),
		})
		const contract = prepareWorkbenchContentContract(
			document,
			plan([{ kind: 'data', key: 'status', display: 'block' }]),
		)

		expect(contract.presentation.slots).toHaveLength(1)
	})

	it('rejects artifact/declaration key, kind, and action metadata mismatches', () => {
		const dataArtifact = plan([{ kind: 'data', key: 'status', display: 'block' }])
		const wrongKey = workbench.markdown(import.meta.url, './fixtures/data.md', {
			other: workbench.data(v.string()),
		})
		const wrongKind = workbench.markdown(import.meta.url, './fixtures/data.md', {
			status: workbench.action({ label: 'Status' }),
		})
		const actionArtifact = plan([
			{
				kind: 'action',
				key: 'refresh',
				display: 'block',
				label: 'Artifact label',
				input: 'none',
			},
		])
		const wrongMetadata = workbench.markdown(import.meta.url, './fixtures/action.md', {
			refresh: workbench.action({ label: 'Declaration label' }),
		})

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
		const document = workbench.markdown(import.meta.url, './fixtures/interactive.md', {
			refresh: workbench.action({ label: 'Refresh' }),
			status: workbench.data(v.object({ count: v.number() })),
		})
		const contract = prepareWorkbenchContentContract(
			document,
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
