import {
	Autocomplete,
	MultiSelect,
	Radio,
	SegmentedControl,
	Select,
	Stack,
	TagsInput,
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
		max?: number
		create?: boolean
		control?: 'select' | 'segmented' | 'radio'
		multiple?: boolean
		emptyLabel?: string
	}
	value?: unknown
	onChange: (val: unknown) => void
	onBlur?: () => void
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
	),
)
SelectOptionItem.displayName = 'PicklistOptionItem'

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

	const allValues: (string | number)[] = []
	for (const opt of options ?? []) allValues.push(opt)
	for (const entry of entries ?? []) allValues.push(entry.value)
	const isAllNumbers = allValues.length > 0 && allValues.every((opt) => typeof opt === 'number')
	return { entries: mapped, isAllNumbers }
}

export function PicklistControl({
	meta,
	value,
	onChange,
	onBlur,
	disabled,
	required,
}: PicklistControlProps) {
	const multiple = Boolean(meta.multiple)
	const variant = meta.control ?? (multiple ? 'select' : 'select')

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
		() => (value == null ? '' : (rawToId.get(value as any) ?? String(value))),
		[value, rawToId],
	)

	const multiValue = useMemo(() => {
		if (!Array.isArray(value)) return []
		return (value as (string | number)[]).map((item) => rawToId.get(item) ?? String(item))
	}, [value, rawToId])

	const searchable = meta.searchable ?? (meta.options?.length ?? 0) >= 8
	const clearable = meta.clearable ?? !required
	const allowCreate = Boolean(meta.create)

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

	const nothingFound = meta.emptyLabel ?? (searchable ? '无匹配项' : undefined)

	if (multiple) {
		if (allowCreate) {
			const tagsData = optionsState.map((option) => ({
				value: option.value,
				...(option.disabled ? { disabled: true } : {}),
			}))
			return (
				<TagsInput
					data={tagsData}
					value={multiValue}
					onChange={(ids) => {
						const cleaned = ids.map((id) => id.trim()).filter(Boolean)
						const raw = cleaned
							.map((id) => toRaw(id))
							.filter((item) => item !== null) as (string | number)[]
						onChange(raw)
					}}
					onBlur={onBlur as any}
					clearable={clearable}
					maxTags={meta.max}
					placeholder={meta.placeholder}
					disabled={disabled}
					comboboxProps={{ withinPortal: true, position: 'bottom-start' as const }}
					maxDropdownHeight={280}
				/>
			)
		}

		const multiSelectProps: any = {
			data: sharedData,
			value: multiValue,
			onChange: (ids: string[]) => {
				const raw = ids.map((id) => toRaw(id)).filter((item) => item !== null) as (
					| string
					| number
				)[]
				onChange(raw)
			},
			onBlur,
			searchable,
			clearable,
			hidePickedOptions: true,
			withScrollArea: true,
			comboboxProps: { withinPortal: true, position: 'bottom-start' as const },
			maxDropdownHeight: 280,
		}

		if (meta.placeholder) multiSelectProps.placeholder = meta.placeholder
		if (disabled !== undefined) multiSelectProps.disabled = disabled
		if (meta.max) multiSelectProps.maxValues = meta.max
		if (nothingFound) multiSelectProps.nothingFoundMessage = nothingFound
		if (SelectOptionItem) multiSelectProps.renderOption = SelectOptionItem

		return <MultiSelect {...multiSelectProps} />
	}

	if (variant === 'segmented') {
		return (
			<SegmentedControl
				data={sharedData as any}
				value={singleValue || null}
				onChange={(id) => onChange(toRaw(id))}
				onBlur={onBlur}
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
				onBlur={onBlur}
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

	// Single select
	if (allowCreate) {
		const autoData = optionsState.map((option) => option.value)
		return (
			<Autocomplete
				data={autoData}
				value={singleValue || ''}
				onChange={(next) => {
					const trimmed = next.trim()
					if (!trimmed) {
						onChange(null)
						return
					}
					onChange(toRaw(trimmed))
				}}
				onBlur={onBlur as any}
				placeholder={meta.placeholder}
				disabled={disabled}
				clearable={clearable}
				comboboxProps={{ withinPortal: true, position: 'bottom-start' as const }}
				maxDropdownHeight={280}
			/>
		)
	}

	const selectProps: any = {
		data: selectData,
		value: singleValue || null,
		onChange: (id: string | null) => onChange(toRaw(id)),
		onBlur,
		searchable,
		clearable,
		comboboxProps: { withinPortal: true, position: 'bottom-start' as const },
	}

	if (meta.placeholder) selectProps.placeholder = meta.placeholder
	if (disabled !== undefined) selectProps.disabled = disabled
	if (nothingFound) selectProps.nothingFoundMessage = nothingFound
	if (SelectOptionItem) selectProps.renderOption = SelectOptionItem

	return <Select {...selectProps} />
}
