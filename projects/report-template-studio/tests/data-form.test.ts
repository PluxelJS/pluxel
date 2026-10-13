import { expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { FieldNode } from 'valibot-form'
import { DataForm } from '../src/renderer/data-form'
import { inputData } from '../src/backend/inputs'
import type { JsonObject } from '../src/shared/contracts'

const capture = vi.hoisted(() => ({ change: undefined as undefined | ((event: unknown) => void) }))
vi.mock('valibot-form/web', () => ({
	AutoForm: Object.assign(
		(props: { formOpts: { listeners: { onChange: typeof capture.change } } }) => {
			capture.change = props.formOpts.listeners.onChange
			return null
		},
		{ Fields: () => null },
	),
}))
vi.mock('@mantine/core', () =>
	Object.fromEntries(
		['Button', 'Checkbox', 'Group', 'NumberInput', 'Select', 'Table', 'Text', 'TextInput'].map(
			(name) => [name, () => null],
		),
	),
)
const fields: FieldNode[] = [
	{
		kind: 'string',
		path: 'title',
		name: 'title',
		depth: 0,
		required: true,
		meta: { label: 'Title' },
		control: 'text',
	},
	{
		kind: 'array',
		path: 'rows',
		name: 'rows',
		depth: 0,
		required: false,
		meta: { label: 'Rows' },
		item: {
			kind: 'object',
			fields: [],
			path: 'rows[]',
			depth: 1,
			required: true,
			meta: { label: 'Row' },
		},
	},
]

it.each<JsonObject>([{}, { rows: [] }, { rows: [{ label: 'existing' }] }])(
	'editing a scalar preserves optional table presence and JSON validity: %j',
	(table) => {
		let emitted: JsonObject | undefined
		renderToStaticMarkup(
			createElement(DataForm, {
				fields,
				data: { title: 'before', ...table },
				onChange: (value) => {
					emitted = value
				},
			}),
		)
		capture.change!({ formApi: { state: { values: { title: 'after' } } } })
		expect(emitted).toStrictEqual({ title: 'after', ...table })
		expect(inputData(emitted)).toStrictEqual(emitted)
	},
)
