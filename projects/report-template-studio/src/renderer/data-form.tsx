import { useMemo, useRef } from 'react'
import { Button, Checkbox, Group, NumberInput, Select, Table, Text, TextInput } from '@mantine/core'
import { AutoForm, type AutoFormOptions } from 'valibot-form/web'
import type { FieldNode } from 'valibot-form'
import type { JsonObject, JsonValue } from '../shared/contracts'

export function DataForm({
	fields,
	data,
	onChange,
}: {
	fields: FieldNode[]
	data: JsonObject
	onChange(data: JsonObject): void
}) {
	const tableFields = fields.filter(
		(field) => field.kind === 'array' && field.item?.kind === 'object',
	)
	const formFields = useMemo(() => fields.filter((field) => !tableFields.includes(field)), [fields])
	const current = useRef(data)
	current.current = data
	const options = useMemo(
		() =>
			({
				defaultValues: data,
				listeners: {
					onChange: ({ formApi }) =>
						onChange({
							...formApi.state.values,
							...Object.fromEntries(
								tableFields.map((field) => {
									const key = field.name ?? field.path
									return [key, current.current[key]]
								}),
							),
						}),
				},
			}) satisfies AutoFormOptions<JsonObject>,
		[data, onChange],
	)
	return (
		<div className="data-form">
			<AutoForm fields={formFields} formOpts={options}>
				<AutoForm.Fields sectionSpacing="md" />
			</AutoForm>
			{tableFields.map((field) => {
				if (field.kind !== 'array' || field.item?.kind !== 'object') return null
				const key = field.name ?? field.path
				const rows = (Array.isArray(data[key]) ? data[key] : []) as JsonObject[]
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
												const change = (next: JsonValue) =>
													update(
														rows.map((item, i) => (i === index ? { ...item, [name]: next } : item)),
													)
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
													onClick={() => update(rows.filter((_, i) => i !== index))}
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
									...rows,
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
