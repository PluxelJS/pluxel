import {
	ActionIcon,
	Button,
	Card,
	Group,
	NumberInput,
	Stack,
	Switch,
	Table,
	Text,
	TextInput,
	Textarea,
} from '@mantine/core'
import { IconArrowDown, IconArrowUp, IconPlus, IconTrash } from '@tabler/icons-react'
import { useEffect, useMemo, useState } from 'react'
import type { RecordMetaResult } from '~/core/actions/record'
import type { CommonProps } from '~/core/registry'
import { registerRenderer, triggerFormEvents } from '~/core/registry'
import { META_MAP } from '~/core/utils'
import { FieldChrome } from '../shared'

type RendererProps = CommonProps<typeof META_MAP.RECORD> & { value?: Record<string, unknown> }
type RecordUI = RecordMetaResult

function inferMode(
	mode: RecordUI['valueMode'],
	value: unknown,
): Exclude<RecordUI['valueMode'], 'auto' | undefined> | 'string' {
	if (mode && mode !== 'auto') return mode
	if (typeof value === 'number') return 'number'
	if (typeof value === 'boolean') return 'boolean'
	if (value && typeof value === 'object') return 'json'
	return 'string'
}

function RecordField(props: RendererProps) {
	const { formBaseInfo, errors, extractedPropsInfo, inputProps, value } = props
	const ep = extractedPropsInfo ?? {}
	const rows = useMemo(
		() => Object.entries((value as Record<string, unknown>) ?? {}),
		[value],
	)
	const layout = ep.layout ?? 'table'
	const minItems = ep.minItems ?? 0
	const maxItems = ep.maxItems
	const canAdd = ep.addable !== false && !inputProps.disabled && (!maxItems || rows.length < maxItems)
	const canRemove = ep.removable !== false
	const canReorder = ep.reorderable !== false
	const editableKey = ep.editableKey !== false
	const baseErrors = (errors ?? [])
		.filter((err) => err.dotPath.length <= 1)
		.map((err) => err.message)

	const entryErrors = useMemo(() => {
		const map = new Map<string, string[]>()
		for (const err of errors ?? []) {
			if (err.dotPath.length <= 1) continue
			const key = err.dotPath[1]
			if (!map.has(key)) map.set(key, [])
			map.get(key)!.push(err.message)
		}
		return map
	}, [errors])

	const [jsonErrors, setJsonErrors] = useState<Record<number, string | undefined>>({})

	useEffect(() => {
		setJsonErrors({})
	}, [rows.length])

	const commitRows = (nextRows: [string, unknown][]) => {
		const next: Record<string, unknown> = {}
		for (const [k, v] of nextRows) {
			next[k] = v
		}
		triggerFormEvents(inputProps, next)
	}

	const handleKeyChange = (index: number, nextKey: string) => {
		const next = [...rows]
		const [, currentValue] = next[index]
		next[index] = [nextKey, currentValue]
		commitRows(next)
	}

	const handleValueChange = (index: number, nextValue: unknown) => {
		const next = [...rows]
		const [currentKey] = next[index]
		next[index] = [currentKey, nextValue]
		commitRows(next)
	}

	const handleRemove = (index: number) => {
		if (!canRemove || inputProps.disabled) return
		if (rows.length <= minItems) return
		const next = rows.filter((_, idx) => idx !== index)
		commitRows(next)
	}

	const handleMove = (index: number, direction: number) => {
		if (!canReorder || inputProps.disabled) return
		const target = index + direction
		if (target < 0 || target >= rows.length) return
		const next = [...rows]
		const [removed] = next.splice(index, 1)
		next.splice(target, 0, removed)
		commitRows(next)
	}

	const handleAdd = () => {
		const next = [...rows, ['', '']]
		commitRows(next)
	}

	const renderValueControl = (index: number, value: unknown) => {
		const mode = inferMode(ep.valueMode, value)
		switch (mode) {
			case 'number':
				return (
					<NumberInput
						value={typeof value === 'number' ? value : ''}
						onChange={(val) => {
							const parsed = val === '' || val === undefined ? undefined : Number(val)
							handleValueChange(index, parsed ?? 0)
						}}
						disabled={inputProps.disabled}
					/>
				)
			case 'boolean':
				return (
					<Switch
						checked={Boolean(value)}
						onChange={(event) => handleValueChange(index, event.currentTarget.checked)}
						disabled={inputProps.disabled}
					/>
				)
			case 'json': {
				const formatted =
					value && typeof value === 'object'
						? JSON.stringify(value, null, 2)
						: typeof value === 'string'
							? value
							: '{}'
				return (
					<Textarea
						key={`${index}-${rows.length}-${formatted.length}`}
						defaultValue={formatted}
						minRows={4}
						autosize
						onBlur={(event) => {
							try {
								const parsed = JSON.parse(event.currentTarget.value || '{}')
								handleValueChange(index, parsed)
								setJsonErrors((prev) => {
									const next = { ...prev }
									delete next[index]
									return next
								})
							} catch {
								setJsonErrors((prev) => ({
									...prev,
									[index]: 'JSON 格式错误',
								}))
							}
						}}
						disabled={inputProps.disabled}
						styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)' } }}
					/>
				)
			}
			default:
				return (
					<TextInput
						value={typeof value === 'string' ? value : value == null ? '' : String(value)}
						onChange={(event) => handleValueChange(index, event.currentTarget.value)}
						placeholder={ep.valuePlaceholder}
						disabled={inputProps.disabled}
					/>
				)
		}
	}

	const rowsNode =
		rows.length === 0 ? (
			<Card withBorder p="md">
				<Text size="sm" c="dimmed">
					{ep.emptyHint ?? '暂无数据，点击下方按钮添加键值对。'}
				</Text>
			</Card>
		) : layout === 'table' ? (
			<Table highlightOnHover withTableBorder withColumnBorders>
				<Table.Thead>
					<Table.Tr>
						<Table.Th style={{ width: ep.columns?.key ?? 200 }}>
							{ep.keyLabel ?? '键'}
						</Table.Th>
						<Table.Th>{ep.valueLabel ?? '值'}</Table.Th>
						<Table.Th style={{ width: 120 }}>操作</Table.Th>
					</Table.Tr>
				</Table.Thead>
				<Table.Tbody>
					{rows.map(([key, val], idx) => {
						const errKey = key ?? String(idx)
						const inlineErrors = [
							...(entryErrors.get(errKey) ?? []),
							jsonErrors[idx],
						].filter(Boolean) as string[]
						return (
							<Table.Tr key={`record-row-${idx}`}>
								<Table.Td>
									<TextInput
										value={key}
										onChange={(event) => handleKeyChange(idx, event.currentTarget.value)}
										placeholder={ep.keyPlaceholder}
										disabled={!editableKey || inputProps.disabled}
									/>
								</Table.Td>
								<Table.Td>
									<Stack gap={4}>
										{renderValueControl(idx, val)}
										{inlineErrors.length ? (
											<Text size="xs" c="red.6">
												{inlineErrors.join(', ')}
											</Text>
										) : null}
									</Stack>
								</Table.Td>
								<Table.Td>
									<Group gap="xs">
										{canReorder ? (
											<>
												<ActionIcon
													variant="subtle"
													onClick={() => handleMove(idx, -1)}
													disabled={idx === 0 || inputProps.disabled}
													aria-label="上移"
												>
													<IconArrowUp size={16} />
												</ActionIcon>
												<ActionIcon
													variant="subtle"
													onClick={() => handleMove(idx, 1)}
													disabled={idx === rows.length - 1 || inputProps.disabled}
													aria-label="下移"
												>
													<IconArrowDown size={16} />
												</ActionIcon>
											</>
										) : null}
										{canRemove ? (
											<ActionIcon
												variant="subtle"
												color="red"
												onClick={() => handleRemove(idx)}
												disabled={inputProps.disabled || rows.length <= minItems}
												aria-label="删除"
											>
												<IconTrash size={16} />
											</ActionIcon>
										) : null}
									</Group>
								</Table.Td>
							</Table.Tr>
						)
					})}
				</Table.Tbody>
			</Table>
		) : (
			<Stack gap="md">
				{rows.map(([key, val], idx) => {
					const errKey = key ?? String(idx)
					const inlineErrors = [
						...(entryErrors.get(errKey) ?? []),
						jsonErrors[idx],
					].filter(Boolean) as string[]
					return (
						<Card key={`record-row-${idx}`} withBorder p="md">
							<Stack gap="sm">
								<TextInput
									label={ep.keyLabel ?? '键'}
									value={key}
									onChange={(event) => handleKeyChange(idx, event.currentTarget.value)}
									placeholder={ep.keyPlaceholder}
									disabled={!editableKey || inputProps.disabled}
								/>
								<Stack gap={4}>
									{renderValueControl(idx, val)}
									{inlineErrors.length ? (
										<Text size="xs" c="red.6">
											{inlineErrors.join(', ')}
										</Text>
									) : null}
								</Stack>
								<Group gap="xs" justify="flex-end">
									{canReorder ? (
										<>
											<ActionIcon
												variant="subtle"
												onClick={() => handleMove(idx, -1)}
												disabled={idx === 0 || inputProps.disabled}
												aria-label="上移"
											>
												<IconArrowUp size={16} />
											</ActionIcon>
											<ActionIcon
												variant="subtle"
												onClick={() => handleMove(idx, 1)}
												disabled={idx === rows.length - 1 || inputProps.disabled}
												aria-label="下移"
											>
												<IconArrowDown size={16} />
											</ActionIcon>
										</>
									) : null}
									{canRemove ? (
										<ActionIcon
											variant="subtle"
											color="red"
											onClick={() => handleRemove(idx)}
											disabled={inputProps.disabled || rows.length <= minItems}
											aria-label="删除"
										>
											<IconTrash size={16} />
										</ActionIcon>
									) : null}
								</Group>
							</Stack>
						</Card>
					)
				})}
			</Stack>
		)

	return (
		<FieldChrome
			label={formBaseInfo.label}
			required={formBaseInfo.required}
			description={formBaseInfo.description}
			helperText={formBaseInfo.helperText}
			hint={formBaseInfo.hint}
			tooltip={formBaseInfo.tooltip}
			badge={formBaseInfo.badge}
			errors={baseErrors}
		>
			<Stack gap="md">
				{rowsNode}
				{canAdd ? (
					<Button
						leftSection={<IconPlus size={16} />}
						variant="light"
						onClick={handleAdd}
						disabled={inputProps.disabled}
					>
						{ep.addLabel ?? '新增键值对'}
					</Button>
				) : null}
			</Stack>
		</FieldChrome>
	)
}

registerRenderer(META_MAP.RECORD, (props) => <RecordField {...(props as RendererProps)} />)
