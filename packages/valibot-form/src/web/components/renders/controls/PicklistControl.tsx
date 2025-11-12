import {
	Badge,
	CloseButton,
	MultiSelect,
	Radio,
	SegmentedControl,
	Select,
	Stack,
	Text,
} from '@mantine/core'
import { forwardRef, useCallback, useEffect, useMemo, useState } from 'react'

export interface PicklistControlProps {
	meta: {
		options?: readonly (string | number)[]
		entries?: readonly {
			value: string | number
			label?: string
			description?: string
			group?: string
			disabled?: boolean
			accentColor?: string
		}[]
		labels?: Partial<Record<string | number, string>>
		disabled?: readonly (string | number)[]
		placeholder?: string
		searchable?: boolean
		clearable?: boolean
		maxSelections?: number
		allowCreate?: boolean
		variant?: 'select' | 'segmented' | 'radio'
		multiple?: boolean
		nothingFoundLabel?: string
	}
	value?: unknown
	onChange: (val: unknown) => void
	disabled?: boolean
	required?: boolean
}

interface NormalizedOption {
	value: string
	label: string
	disabled?: boolean
	raw: string | number
	description?: string
	group?: string
	accentColor?: string
}

const SelectOptionItem = forwardRef<HTMLDivElement, any>(
	({ label, description, accentColor, ...others }, ref) => (
		<div ref={ref} {...others}>
			<Text fw={500} size="sm" {...(accentColor && { c: `${accentColor}.6` })}>
				{label}
			</Text>
			{description ? (
				<Text size="xs" c="dimmed">
					{description}
				</Text>
			) : null}
		</div>
	)
)
SelectOptionItem.displayName = 'PicklistOptionItem'

const MultiValueChip = forwardRef<HTMLDivElement, any>(
	({ label, onRemove, disabled, data, ...others }, ref) => (
		<Badge
			ref={ref}
			radius="sm"
			variant="light"
			color={(data as any)?.accentColor}
			pr={disabled ? 12 : 4}
			pl={10}
			styles={{ root: { display: 'inline-flex', alignItems: 'center', gap: 4 } }}
			{...others}
		>
			<Text size="sm">{label}</Text>
			{disabled ? null : (
				<CloseButton
					size="xs"
					variant="transparent"
					onMouseDown={onRemove}
					onClick={onRemove}
				/>
			)}
		</Badge>
	),
)
MultiValueChip.displayName = 'PicklistValueChip'

function normalizeOptions(
	options: readonly (string | number)[] = [],
	entries?: PicklistControlProps['meta']['entries'],
	labels?: Partial<Record<string | number, string>>,
	disabled?: readonly (string | number)[],
) {
	const disabledSet = new Set((disabled ?? []).map((item) => String(item)))
	const mapped: NormalizedOption[] = []
	const seen = new Set<string | number>()

	for (const entry of entries ?? []) {
		const raw = entry.value
		seen.add(raw)
		mapped.push({
			value: String(raw),
			label: entry.label ?? labels?.[raw] ?? String(raw),
			description: entry.description,
			group: entry.group,
			accentColor: entry.accentColor,
			disabled: entry.disabled ?? disabledSet.has(String(raw)),
			raw,
		})
	}

	for (const opt of options ?? []) {
		if (seen.has(opt)) continue
		mapped.push({
			value: String(opt),
			label: labels?.[opt] ?? String(opt),
			disabled: disabledSet.has(String(opt)),
			raw: opt,
		})
	}

	const isAllNumbers =
		(options?.length ?? 0) > 0 && (options ?? []).every((opt) => typeof opt === 'number')
	return { entries: mapped, isAllNumbers }
}

export function PicklistControl({ meta, value, onChange, disabled, required }: PicklistControlProps) {
	const multiple = Boolean(meta.multiple)
	const variant = meta.variant ?? (multiple ? 'select' : 'select')

	const normalized = useMemo(
		() => normalizeOptions(meta.options, meta.entries, meta.labels, meta.disabled),
		[meta.options, meta.entries, meta.labels, meta.disabled],
	)

	const [optionsState, setOptionsState] = useState<NormalizedOption[]>(normalized.entries)

	useEffect(() => {
		setOptionsState(normalized.entries)
	}, [normalized.entries])

	const ensureOption = useCallback(
		(raw?: string | number | null) => {
			if (raw == null) return
			setOptionsState((prev) => {
				if (prev.some((opt) => opt.raw === raw)) return prev
				return [
					...prev,
					{ value: String(raw), label: meta.labels?.[raw as any] ?? String(raw), raw },
				]
			})
		},
		[meta.labels],
	)

	useEffect(() => {
		if (Array.isArray(value)) {
			value.forEach((item) => {
				if (typeof item === 'string' || typeof item === 'number') ensureOption(item)
			})
		} else if (typeof value === 'string' || typeof value === 'number') {
			ensureOption(value)
		}
	}, [value, ensureOption])

	const optionMap = useMemo(() => {
		const map = new Map<string, NormalizedOption>()
		for (const opt of optionsState) map.set(opt.value, opt)
		return map
	}, [optionsState])

	const rawToId = useMemo(() => {
		const map = new Map<string | number, string>()
		for (const opt of optionsState) map.set(opt.raw, opt.value)
		return map
	}, [optionsState])

	const toRaw = useCallback(
		(id: string | null) => {
			if (id === null) return null
			const match = optionMap.get(id)
			if (match) return match.raw
			return normalized.isAllNumbers ? Number(id) : id
		},
		[optionMap, normalized.isAllNumbers],
	)

	const singleValue = useMemo(
		() => (value == null ? '' : rawToId.get(value as any) ?? String(value)),
		[value, rawToId],
	)

	const multiValue = useMemo(() => {
		if (!Array.isArray(value)) return []
		return (value as (string | number)[]).map((item) => rawToId.get(item) ?? String(item))
	}, [value, rawToId])

	const searchable = meta.searchable ?? (meta.options?.length ?? 0) >= 8
	const clearable = meta.clearable ?? !required
	const allowCreate = Boolean(meta.allowCreate)

	const sharedData = useMemo(() => {
		const loose: NormalizedOption[] = []
		const groups = new Map<string, NormalizedOption[]>()
		for (const option of optionsState) {
			if (option.group) {
				const bucket = groups.get(option.group) ?? []
				bucket.push(option)
				groups.set(option.group, bucket)
			} else {
				loose.push(option)
			}
		}
		const all: NormalizedOption[] = []
		for (const [, items] of groups) {
			all.push(...items)
		}
		all.push(...loose)
		return all
	}, [optionsState])

	const selectData = useMemo<any[]>(() => {
		const groups = new Map<string, any[]>()
		const loose: any[] = []
		const toItem = (option: NormalizedOption): any => ({
			value: option.value,
			label: option.label,
			disabled: option.disabled,
			description: option.description,
		})
		for (const option of optionsState) {
			if (option.group) {
				const bucket = groups.get(option.group) ?? []
				bucket.push(toItem(option))
				groups.set(option.group, bucket)
			} else {
				loose.push(toItem(option))
			}
		}
		const data: any[] = []
		for (const [group, items] of groups) {
			data.push({ group, items })
		}
		data.push(...loose)
		return data
	}, [optionsState])

	const handleCreate = useCallback(
		(query: string) => {
			const trimmed = query.trim()
			if (!trimmed) return null
			if (optionMap.has(trimmed)) {
				const existing = optionMap.get(trimmed)!
				return existing.value
			}
			const raw = normalized.isAllNumbers ? Number(trimmed) : trimmed
			const option: NormalizedOption = {
				value: String(trimmed),
				label: trimmed,
				raw,
			}
			setOptionsState((prev) => [...prev, option])
			return option.value
		},
		[optionMap, normalized.isAllNumbers],
	)

	const nothingFound = meta.nothingFoundLabel ?? (searchable ? '无匹配项' : undefined)

	if (multiple) {
		return (
			<MultiSelect
				data={sharedData as any}
				value={multiValue}
				onChange={(ids) => {
					const raw = ids
						.map((id) => toRaw(id))
						.filter((item) => item !== null) as (string | number)[]
					onChange(raw)
				}}
				searchable={searchable}
				clearable={clearable}
				{...(meta.placeholder && { placeholder: meta.placeholder })}
				{...(disabled !== undefined && { disabled })}
				hidePickedOptions
				withScrollArea
				{...(meta.maxSelections && { maxValues: meta.maxSelections })}
				{...(allowCreate && {
					getCreateLabel: (query: string) => `+ 创建 "${query}"`,
					onCreate: handleCreate as any,
				})}
				{...(nothingFound && { nothingFoundMessage: nothingFound })}
				{...(SelectOptionItem && { renderOption: SelectOptionItem as any })}
				comboboxProps={{ withinPortal: true, position: 'bottom-start' }}
				maxDropdownHeight={280}
			/>
		)
	}

	if (variant === 'segmented') {
		return (
			<SegmentedControl
				data={sharedData as any}
				value={singleValue || null}
				onChange={(id) => onChange(toRaw(id))}
				fullWidth
				{...(disabled !== undefined && { disabled })}
			/>
		)
	}

	if (variant === 'radio') {
		return (
			<Radio.Group
				value={singleValue || null}
				onChange={(id) => onChange(toRaw(id))}
				{...(disabled !== undefined && { disabled })}
			>
				<Stack gap={6} mt="xs">
					{sharedData.map((option) => (
						<Radio
							key={option.value}
							value={option.value}
							label={option.label}
							{...(option.disabled && { disabled: option.disabled })}
						/>
					))}
				</Stack>
			</Radio.Group>
		)
	}

	return (
		<Select
			data={selectData as any}
			value={singleValue || null}
			onChange={(id) => onChange(toRaw(id))}
			searchable={searchable}
			clearable={clearable}
			{...(meta.placeholder && { placeholder: meta.placeholder })}
			{...(disabled !== undefined && { disabled })}
			{...(nothingFound && { nothingFoundMessage: nothingFound })}
			{...(allowCreate && {
				getCreateLabel: (query: string) => `+ 创建 "${query}"`,
				onCreate: handleCreate as any,
			})}
			{...(SelectOptionItem && { renderOption: SelectOptionItem as any })}
			comboboxProps={{ withinPortal: true, position: 'bottom-start' }}
		/>
	)
}
