// @vitest-environment jsdom
import { MantineProvider } from '@mantine/core'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as v from 'valibot'
import { extractFormFields } from 'valibot-form'
import { DataForm } from '../src/renderer/data-form'
import type { JsonObject } from '../src/shared/contracts'

beforeEach(() => {
	vi.stubGlobal(
		'ResizeObserver',
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	)
	vi.stubGlobal(
		'matchMedia',
		vi.fn(() => ({
			matches: false,
			addEventListener() {},
			removeEventListener() {},
		})),
	)
})
afterEach(() => {
	cleanup()
	vi.unstubAllGlobals()
})

it('shows parsed defaults while writing only actual edits to the original input and table row', () => {
	const increment = () =>
		v.pipe(
			v.number(),
			v.transform((value) => value + 1),
		)
	const schema = v.object({
		count: increment(),
		title: v.string(),
		header: v.object({ bankName: v.optional(v.string(), 'Example Bank') }),
		rows: v.array(
			v.object({
				amount: increment(),
				label: v.optional(v.string(), 'Default row'),
				unit: v.optional(v.string(), 'USD'),
			}),
		),
	})
	const fields = extractFormFields(schema)
	const initial: JsonObject = { count: 1, title: 'Before', header: {}, rows: [{ amount: 1 }] }
	let saved = initial
	const changed = vi.fn((value: JsonObject) => {
		saved = value
	})
	function Consumer() {
		const [data, setData] = useState(initial)
		const [compiled, setCompiled] = useState(false)
		return (
			<MantineProvider>
				<button type="button" onClick={() => setCompiled(true)}>
					Compile parsed snapshot
				</button>
				<DataForm
					fields={fields}
					data={data}
					parsedData={compiled ? v.parse(schema, data) : undefined}
					onChange={(value) => {
						changed(value)
						setData(value)
					}}
				/>
			</MantineProvider>
		)
	}
	const { container } = render(<Consumer />)
	const input = (name: string) =>
		container.querySelector<HTMLInputElement>(`input[name="${name}"]`)!
	const table = fields.find((field) => field.name === 'rows')!
	if (table.kind !== 'array' || table.item?.kind !== 'object') throw new Error('Expected row plan')
	const columns = table.item.fields
	const cell = (name: string) =>
		screen.getByLabelText(
			`${table.meta.label} 第 1 行 ${columns.find((field) => field.name === name)!.meta.label}`,
		) as HTMLInputElement

	expect(changed).not.toHaveBeenCalled()
	expect(v.parse(schema, saved).count).toBe(2)
	expect(input('count').value).toBe('1')
	expect(input('header.bankName').value).toBe('')
	fireEvent.change(input('title'), { target: { value: 'Before compile' } })
	expect(saved).toStrictEqual({ ...initial, title: 'Before compile' })
	fireEvent.click(screen.getByRole('button', { name: 'Compile parsed snapshot' }))
	expect(changed).toHaveBeenCalledTimes(1)
	expect(input('header.bankName').value).toBe('Example Bank')
	expect(cell('amount').value).toBe('1')
	expect(cell('label').value).toBe('Default row')

	fireEvent.change(input('title'), { target: { value: 'Changed title' } })
	expect(saved).toStrictEqual({ ...initial, title: 'Changed title' })
	expect(v.parse(schema, saved).count).toBe(2)

	fireEvent.change(input('header.bankName'), { target: { value: 'Chosen bank' } })
	expect(saved).toStrictEqual({
		...initial,
		title: 'Changed title',
		header: { bankName: 'Chosen bank' },
	})
	fireEvent.change(cell('label'), { target: { value: 'Changed row' } })
	expect(saved).toStrictEqual({
		count: 1,
		title: 'Changed title',
		header: { bankName: 'Chosen bank' },
		rows: [{ amount: 1, label: 'Changed row' }],
	})
	expect(cell('unit').value).toBe('USD')
	fireEvent.change(input('count'), { target: { value: '5' } })
	expect(saved.count).toBe(5)
	expect(v.parse(schema, saved).count).toBe(6)
	fireEvent.change(cell('amount'), { target: { value: '3' } })
	expect(saved.rows).toStrictEqual([{ amount: 3, label: 'Changed row' }])
	expect(v.parse(schema, saved).rows[0]!.amount).toBe(4)
})
