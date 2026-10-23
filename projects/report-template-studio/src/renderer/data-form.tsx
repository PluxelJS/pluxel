import { useEffect, useMemo, useRef } from 'react'
import { Button, Checkbox, Group, NumberInput, Select, Table, Text, TextInput } from '@mantine/core'
import { getBy, setBy } from '@tanstack/react-form'
import { AutoForm, useAutoFormCtx, type AutoFormOptions } from 'valibot-form/web'
import type { FieldNode } from 'valibot-form'
import type { JsonObject, JsonValue } from '../shared/contracts'

function isObject(value: JsonValue | undefined): value is JsonObject {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Schema output supplies missing display values; an explicit draft value always wins. */
function displayValues(raw: JsonValue, parsed?: JsonValue): JsonValue {
	if (Array.isArray(raw)) {
		return raw.map((value, index) =>
			displayValues(value, Array.isArray(parsed) ? parsed[index] : undefined),
		)
	}
	if (isObject(raw) && isObject(parsed)) {
		return {
			...parsed,
			...Object.fromEntries(
				Object.entries(raw).map(([key, value]) => [key, displayValues(value, parsed[key])]),
			),
		}
	}
	return raw
}

/** Copy actual edits to the draft without copying unchanged nested display defaults. */
function changedValues(
	raw: JsonValue | undefined,
	before: JsonValue | undefined,
	after: JsonValue | undefined,
): JsonValue | undefined {
	if (Object.is(before, after)) return raw
	if (!isObject(before) || !isObject(after)) return after
	let result = raw
	for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
		const previous = isObject(result) ? result[key] : undefined
		const next = changedValues(previous, before[key], after[key])
		if (Object.is(previous, next)) continue
		result = { ...(isObject(result) ? result : {}) }
		if (next === undefined) delete result[key]
		else result[key] = next
	}
	return result
}

function DisplayValues({ fields, values }: { fields: FieldNode[]; values: JsonObject }) {
	const { form } = useAutoFormCtx()
	useEffect(() => {
		// TanStack stops applying defaultValues once any field has been touched.
		// A later compile result still needs to supply missing display values.
		for (const field of fields) {
			const name = field.name ?? field.path
			if (Object.is(form.getFieldValue(name), values[name])) continue
			form.setFieldValue(name, values[name], {
				dontRunListeners: true,
				dontUpdateMeta: true,
				dontValidate: true,
			})
		}
	}, [fields, form, values])
	return null
}

export function DataForm({
	fields,
	data,
	parsedData,
	onChange,
}: {
	fields: FieldNode[]
	data: JsonObject
	parsedData?: JsonObject
	onChange(data: JsonObject): void
}) {
	const tableFields = fields.filter(
		(field) => field.kind === 'array' && field.item?.kind === 'object',
	)
	const formFields = useMemo(() => fields.filter((field) => !tableFields.includes(field)), [fields])
	const current = useRef(data)
	current.current = data
	const displayed = useMemo(() => displayValues(data, parsedData) as JsonObject, [data, parsedData])
	const display = useRef(displayed)
	display.current = displayed
	const options = useMemo(
		() =>
			({
				defaultValues: displayed,
				listeners: {
					onChange: ({ fieldApi }) => {
						const path = fieldApi.name
						const raw: JsonValue | undefined = getBy(current.current, path)
						const next = changedValues(raw, getBy(display.current, path), fieldApi.state.value)
						if (!Object.is(raw, next)) onChange(setBy(current.current, path, next))
					},
				},
			}) satisfies AutoFormOptions<JsonObject>,
		[displayed, onChange],
	)
	return (
		<div className="data-form">
			<AutoForm fields={formFields} formOpts={options}>
				<DisplayValues fields={formFields} values={displayed} />
				<AutoForm.Fields sectionSpacing="md" />
			</AutoForm>
			{tableFields.map((field) => {
				if (field.kind !== 'array' || field.item?.kind !== 'object') return null
				const key = field.name ?? field.path
				const tableValue = displayed[key]
				if (
					tableValue !== undefined &&
					(!Array.isArray(tableValue) || !tableValue.every(isObject))
				) {
					return (
						<Text key={key} c="red">
							{field.meta.label} 必须是对象行数组，请检查原始数据。
						</Text>
					)
				}
				const rows = (tableValue ?? []) as JsonObject[]
				const rawRows = (
					Array.isArray(data[key]) ? data[key] : rows.map(() => ({}))
				) as JsonObject[]
				const columns = field.item.fields
				const update = (next: JsonObject[]) => onChange({ ...data, [key]: next })
				return (
					<section key={key} className="line-items">
						<Group justify="space-between" mb="sm">
							<Text fw={600} size="sm">
								{field.meta.label}
							</Text>
							<Text size="xs" c="dimmed">
								{rows.length} 条记录
							</Text>
						</Group>
						<div className="table-scroll">
							<Table withTableBorder withColumnBorders horizontalSpacing="xs" verticalSpacing="xs">
								<Table.Thead>
									<Table.Tr>
										{columns.map((column) => (
											<Table.Th key={column.path}>{column.meta.label}</Table.Th>
										))}
										<Table.Th>
											<span className="sr-only">操作</span>
										</Table.Th>
									</Table.Tr>
								</Table.Thead>
								<Table.Tbody>
									{rows.map((row, index) => (
										<Table.Tr key={index}>
											{columns.map((column) => {
												const name = column.name ?? column.path.split('.').at(-1)!
												const value = row[name]
												const change = (next: JsonValue) => {
													if (Object.is(value, next)) return
													update(
														rawRows.map((item, i) =>
															i === index ? { ...item, [name]: next } : item,
														),
													)
												}
												const label = `${field.meta.label} 第 ${index + 1} 行 ${column.meta.label}`
												return (
													<Table.Td key={column.path}>
														{column.kind === 'number' ? (
															<NumberInput
																aria-label={label}
																value={
																	typeof value === 'number' || typeof value === 'string'
																		? value
																		: ''
																}
																onChange={change}
																hideControls
																min={column.min}
																max={column.max}
															/>
														) : column.kind === 'boolean' ? (
															<Checkbox
																aria-label={label}
																checked={Boolean(value)}
																onChange={(event) => change(event.currentTarget.checked)}
															/>
														) : column.kind === 'picklist' ? (
															<Select
																aria-label={label}
																value={String(value ?? '')}
																data={
																	column.entries?.map((entry) => ({
																		value: String(entry.value),
																		label: entry.label ?? String(entry.value),
																	})) ??
																	column.options?.map((option) => String(option)) ??
																	[]
																}
																onChange={change}
															/>
														) : (
															<TextInput
																aria-label={label}
																value={String(value ?? '')}
																onChange={(event) => change(event.currentTarget.value)}
															/>
														)}
													</Table.Td>
												)
											})}
											<Table.Td>
												<Button
													variant="subtle"
													color="gray"
													size="compact-xs"
													aria-label={`删除第 ${index + 1} 行`}
													onClick={() => update(rawRows.filter((_, i) => i !== index))}
												>
													×
												</Button>
											</Table.Td>
										</Table.Tr>
									))}
								</Table.Tbody>
							</Table>
						</div>
						<Button
							mt="sm"
							variant="light"
							size="xs"
							onClick={() =>
								update([
									...rawRows,
									Object.fromEntries(
										columns.map((column) => [
											column.name ?? column.path.split('.').at(-1)!,
											column.kind === 'number' ? 0 : column.kind === 'boolean' ? false : '',
										]),
									),
								])
							}
						>
							＋ 添加一行
						</Button>
					</section>
				)
			})}
		</div>
	)
}
