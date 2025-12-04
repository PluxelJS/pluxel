import {
	ActionIcon,
	Button,
	Card,
	Group,
	NumberInput,
	Select,
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
import { MetaRenderer, registerRenderer, triggerFormEvents } from '~/core/registry'
import { META_MAP } from '~/core/utils'
import { FieldChrome } from '../shared'
import { cleanProps } from '../../utils/propHelpers'
import { PicklistControl } from './controls/PicklistControl'
import { cachedExtractInfo } from '../schemaCache'

type RendererProps = CommonProps<typeof META_MAP.RECORD> & { value?: Record<string, unknown> }
type RecordUI = RecordMetaResult

const idOf = (value: string | number) => String(value)

function buildPicklistData(config?: NonNullable<RecordUI['picklist']>) {
	if (!config) return { data: [], map: new Map<string, string | number>(), isAllNumbers: false }
	const map = new Map<string, string | number>()
	const disabled = new Set((config.disabled ?? []).map((item) => idOf(item)))
	const data = (config.options ?? []).map((opt) => {
		const id = idOf(opt)
		map.set(id, opt)
		return {
			value: id,
			label: config.labels?.[opt] ?? String(opt),
			disabled: disabled.has(id),
		}
	})
	const isAllNumbers = (config.options ?? []).every((opt) => typeof opt === 'number')
	return { data, map, isAllNumbers }
}

function inferMode(
	mode: RecordUI['valueMode'],
	value: unknown,
): Exclude<RecordUI['valueMode'], 'auto' | undefined> | 'string' {
	if (mode && mode !== 'auto') return mode
	if (Array.isArray(value)) return 'picklist-array'
	if (typeof value === 'number') return 'number'
	if (typeof value === 'boolean') return 'boolean'
	if (value && typeof value === 'object') return 'json'
	return 'string'
}

const slug = (value: string) =>
	value
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/gi, '-')
		.replace(/^-+|-+$/g, '') || 'item'

function RecordField(props: RendererProps) {
	const { formBaseInfo, errors, extractedPropsInfo, inputProps, value } = props
	const ep = extractedPropsInfo ?? {}
	// 使用 state 来保持键的顺序，避免编辑时因对象键重排序导致的跳跃
	const [orderedKeys, setOrderedKeys] = useState<string[]>([])

	const pickMeta = useMemo(() => buildPicklistData(ep.picklist), [ep.picklist])

	const rows = useMemo(() => {
		const entries = Object.entries((value as Record<string, unknown>) ?? {})
		// 如果是第一次加载或 value 的键集合发生了变化，更新 orderedKeys
		const currentKeys = entries.map(([k]) => k)
		const currentKeySet = new Set(currentKeys)
		const orderedKeySet = new Set(orderedKeys)

		// 检查是否需要更新顺序（新增或删除了键）
		const keysChanged =
			currentKeys.length !== orderedKeys.length ||
			currentKeys.some(k => !orderedKeySet.has(k)) ||
			orderedKeys.some(k => !currentKeySet.has(k))

		if (keysChanged) {
			// 保留现有顺序中仍存在的键，然后添加新键
			const preserved = orderedKeys.filter(k => currentKeySet.has(k))
			const newKeys = currentKeys.filter(k => !orderedKeySet.has(k))
			const newOrder = [...preserved, ...newKeys]
			setOrderedKeys(newOrder)
			return newOrder.map(k => [k, (value as Record<string, unknown>)[k]] as [string, unknown])
		}

		// 使用已有的顺序
		return orderedKeys
			.filter(k => currentKeySet.has(k))
			.map(k => [k, (value as Record<string, unknown>)[k]] as [string, unknown])
	}, [value, orderedKeys])
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
		const map = new Map<string, { message: string; dotPath: string[] }[]>()
		for (const err of errors ?? []) {
			if (err.dotPath.length <= 1) continue
			const key = String(err.dotPath[1])
			if (!map.has(key)) map.set(key, [])
			map.get(key)!.push({ message: err.message, dotPath: err.dotPath.slice(1) })
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
		const [oldKey, currentValue] = next[index]
		next[index] = [nextKey, currentValue]

		// 更新有序键列表
		const newOrderedKeys = [...orderedKeys]
		newOrderedKeys[index] = nextKey
		setOrderedKeys(newOrderedKeys)

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
		const next: [string, unknown][] = [...rows, ['', '']]
		commitRows(next)
	}

	const renderValueControl = (index: number, value: unknown) => {
		const mode = inferMode(ep.valueMode, value)
		switch (mode) {
			case 'number':
				return (
					<NumberInput
						{...cleanProps({
							value: typeof value === 'number' ? value : '',
							onChange: (val: string | number) => {
								const parsed = val === '' || val === undefined ? undefined : Number(val)
								handleValueChange(index, parsed ?? 0)
							},
							disabled: inputProps.disabled,
						})}
					/>
				)
			case 'boolean':
				return (
					<Switch
						{...cleanProps({
							checked: Boolean(value),
							onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
								handleValueChange(index, event.currentTarget.checked),
							disabled: inputProps.disabled,
						})}
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
						{...cleanProps({
							key: `${index}-${rows.length}-${formatted.length}`,
							defaultValue: formatted,
							minRows: 4,
							autosize: true,
							onBlur: (event: React.FocusEvent<HTMLTextAreaElement>) => {
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
							},
							disabled: inputProps.disabled,
							styles: { input: { fontFamily: 'var(--mantine-font-family-monospace)' } },
						})}
					/>
				)
			}
			case 'picklist': {
				const currentId = value == null ? null : idOf(value as string | number)
				return (
					<Select
						data={pickMeta.data}
						value={currentId ?? null}
						onChange={(id) => {
							if (id === null) return handleValueChange(index, null)
							const raw = pickMeta.map.get(id!) ?? (pickMeta.isAllNumbers ? Number(id) : id)
							handleValueChange(index, raw)
						}}
						disabled={inputProps.disabled ?? false}
						{...cleanProps({
							placeholder: ep.picklist?.placeholder,
							clearable: ep.picklist?.clearable,
							searchable: ep.picklist?.searchable,
						})}
					/>
				)
			}
			case 'picklist-array': {
				return (
					<PicklistControl
						meta={{
							clearable: ep.picklist?.clearable ?? true,
							allowCreate: ep.picklist?.allowCreate ?? false,
							variant: ep.picklist?.variant ?? 'select',
							multiple: true,
							...cleanProps({
								options: ep.picklist?.options,
								entries: ep.picklist?.entries,
								labels: ep.picklist?.labels,
								disabled: ep.picklist?.disabled,
								placeholder: ep.picklist?.placeholder,
								searchable: ep.picklist?.searchable,
								maxSelections: ep.picklist?.maxValues,
								nothingFoundLabel: ep.picklist?.nothingFoundLabel,
							}),
						} as any}
						value={Array.isArray(value) ? value : []}
						onChange={(next) => {
							if (Array.isArray(next)) handleValueChange(index, next)
							else if (next == null) handleValueChange(index, [])
							else handleValueChange(index, [next])
						}}
						disabled={inputProps.disabled ?? false}
						required={false}
					/>
				)
			}
			case 'object':
			case 'array':
			case 'union':
			case 'variant': {
				const itemInfo = cachedExtractInfo(ep.valueSchema as object, `${index}`)
				if (!itemInfo) return null

				const nestedName = inputProps.name ? `${inputProps.name}.${rows[index]?.[0] ?? index}` : String(index)
				const nestedInputProps = {
					name: nestedName,
					onChange: (nextValue: unknown) => handleValueChange(index, nextValue),
					onBlur: () => inputProps.onBlur?.({ target: { name: nestedName } } as any),
					disabled: inputProps.disabled,
					readOnly: inputProps.readOnly,
				}
				const nestedErrors = (entryErrors.get(rows[index]?.[0] ?? '') ?? []).map((err) => ({
					message: err.message,
					dotPath: err.dotPath,
				}))

				const nestedProps =
					itemInfo.type === 'object'
						? { ...itemInfo.props, variant: 'stack' as const, gap: 'sm', columns: itemInfo.props.columns ?? 2 }
						: itemInfo.type === 'array'
							? { ...itemInfo.props, disableAutoGrid: true }
							: itemInfo.type === 'union'
								? { ...itemInfo.props, compact: true }
								: itemInfo.props

				return (
					<MetaRenderer
						type={itemInfo.type}
						formBaseInfo={{ ...itemInfo.formInfo, label: undefined, hideLabel: true, hideRequired: true }}
						extractedPropsInfo={nestedProps}
						errors={nestedErrors}
						value={value}
						inputProps={nestedInputProps as any}
					/>
				)
			}
			default:
				return (
					<TextInput
						{...cleanProps({
							value: typeof value === 'string' ? value : value == null ? '' : String(value),
							onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
								handleValueChange(index, event.currentTarget.value),
							placeholder: ep.valuePlaceholder,
							disabled: inputProps.disabled,
						})}
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
						const keyDisplay = key ?? ''
						const entryLabel = keyDisplay === '' ? `条目 ${idx + 1}` : String(keyDisplay)
						const errKey = keyDisplay === '' ? String(idx) : String(keyDisplay)
						const inlineErrors = [
							...(entryErrors.get(errKey)?.map((e) => e.message) ?? []),
							jsonErrors[idx],
						].filter(Boolean) as string[]
						const anchorId = `${inputProps.name ?? 'record'}-${slug(entryLabel)}-${idx}`
						return (
							<Table.Tr key={`record-row-${idx}`}>
								<Table.Td style={{ position: 'relative' }}>
									<div
										id={anchorId}
										data-config-anchor
										data-config-anchor-depth={3}
										data-config-anchor-label={entryLabel}
										style={{ position: 'absolute', inset: 0, height: 0, scrollMarginTop: '72px' }}
									/>
									<TextInput
										{...cleanProps({
											value: keyDisplay,
											onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
												handleKeyChange(idx, event.currentTarget.value),
											placeholder: ep.keyPlaceholder,
											disabled: !editableKey || inputProps.disabled,
										})}
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
													{...cleanProps({
														variant: 'subtle' as const,
														onClick: () => handleMove(idx, -1),
														disabled: idx === 0 || inputProps.disabled,
														'aria-label': '上移',
													})}
												>
													<IconArrowUp size={16} />
												</ActionIcon>
												<ActionIcon
													{...cleanProps({
														variant: 'subtle' as const,
														onClick: () => handleMove(idx, 1),
														disabled: idx === rows.length - 1 || inputProps.disabled,
														'aria-label': '下移',
													})}
												>
													<IconArrowDown size={16} />
												</ActionIcon>
											</>
										) : null}
										{canRemove ? (
											<ActionIcon
												{...cleanProps({
													variant: 'subtle' as const,
													color: 'red',
													onClick: () => handleRemove(idx),
													disabled: inputProps.disabled || rows.length <= minItems,
													'aria-label': '删除',
												})}
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
					const keyDisplay = key ?? ''
					const entryLabel = keyDisplay === '' ? `条目 ${idx + 1}` : String(keyDisplay)
					const errKey = keyDisplay === '' ? String(idx) : String(keyDisplay)
					const inlineErrors = [
						...(entryErrors.get(errKey)?.map((e) => e.message) ?? []),
						jsonErrors[idx],
					].filter(Boolean) as string[]
					const anchorId = `${inputProps.name ?? 'record'}-${slug(entryLabel)}-${idx}`
					return (
						<Card key={`record-row-${idx}`} withBorder p="md" style={{ scrollMarginTop: '72px', position: 'relative' }}>
							<div
								id={anchorId}
								data-config-anchor
								data-config-anchor-depth={3}
								data-config-anchor-label={entryLabel}
								style={{ position: 'absolute', inset: 0, height: 0 }}
							/>
							<Stack gap="sm">
								<Group justify="space-between" align="center">
									<Text fw={600}>{entryLabel}</Text>
									<Text size="xs" c="dimmed">
										{formBaseInfo.label}
									</Text>
								</Group>
								<TextInput
									{...cleanProps({
										label: ep.keyLabel ?? '键',
										value: keyDisplay,
										onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
											handleKeyChange(idx, event.currentTarget.value),
										placeholder: ep.keyPlaceholder,
										disabled: !editableKey || inputProps.disabled,
									})}
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
												{...cleanProps({
													variant: 'subtle' as const,
													onClick: () => handleMove(idx, -1),
													disabled: idx === 0 || inputProps.disabled,
													'aria-label': '上移',
												})}
											>
												<IconArrowUp size={16} />
											</ActionIcon>
											<ActionIcon
												{...cleanProps({
													variant: 'subtle' as const,
													onClick: () => handleMove(idx, 1),
													disabled: idx === rows.length - 1 || inputProps.disabled,
													'aria-label': '下移',
												})}
											>
												<IconArrowDown size={16} />
											</ActionIcon>
										</>
									) : null}
									{canRemove ? (
										<ActionIcon
											{...cleanProps({
												variant: 'subtle' as const,
												color: 'red',
												onClick: () => handleRemove(idx),
												disabled: inputProps.disabled || rows.length <= minItems,
												'aria-label': '删除',
											})}
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
			{...cleanProps({
				label: formBaseInfo.label,
				required: formBaseInfo.required,
				description: formBaseInfo.description,
				helperText: formBaseInfo.helperText,
				hint: formBaseInfo.hint,
				tooltip: formBaseInfo.tooltip,
				badge: formBaseInfo.badge,
				errors: baseErrors,
			})}
		>
			<Stack gap="md">
				{rowsNode}
				{canAdd ? (
					<Button
						{...cleanProps({
							leftSection: <IconPlus size={16} />,
							variant: 'light' as const,
							onClick: handleAdd,
							disabled: inputProps.disabled,
						})}
					>
						{ep.addLabel ?? '新增键值对'}
					</Button>
				) : null}
			</Stack>
		</FieldChrome>
	)
}

registerRenderer(META_MAP.RECORD, (props) => <RecordField {...(props as RendererProps)} />)
