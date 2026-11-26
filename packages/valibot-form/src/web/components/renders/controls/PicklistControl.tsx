import { Autocomplete, MultiSelect, Radio, Select, Stack, TagsInput, Text } from '@mantine/core'
import { useMemo } from 'react'
import type { PicklistFieldNode } from '../../../../core/fields'
import { SegmentedButtons } from '../../SegmentedButtons'

interface PicklistControlProps {
	node: PicklistFieldNode
	multiple?: boolean
	maxValues?: number
	value?: unknown
	onChange: (val: unknown) => void
	onBlur?: () => void
	disabled?: boolean
	required?: boolean
	ariaLabel?: string
	id?: string
	name?: string
	'aria-invalid'?: boolean
	'aria-describedby'?: string
	/** Composite controls own their Mantine error so the focusable input receives its association. */
	error?: string
}

type Choice = string | number
type Entry = NonNullable<PicklistFieldNode['entries']>[number]
type NormalizedOption = Omit<Entry, 'value' | 'label'> & {
	value: string
	label: string
	raw: Choice
}

function isChoice(value: unknown): value is Choice {
	return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))
}

function normalizeOptions(meta: PicklistFieldNode, current: unknown) {
	const entries = new Map<Choice, Entry>()
	for (const entry of meta.entries ?? []) entries.set(entry.value, entry)
	for (const value of meta.options ?? []) {
		if (!entries.has(value)) entries.set(value, { value })
	}
	const numeric =
		entries.size > 0 && [...entries.keys()].every((value) => typeof value === 'number')
	// A saved or newly entered value remains visible even when it is outside the suggested options.
	for (const value of Array.isArray(current) ? current : [current]) {
		if (isChoice(value) && !entries.has(value)) entries.set(value, { value })
	}

	const disabled = new Set(meta.disabled)
	const spellings = new Set(Array.from(entries.keys(), String))
	const numbers = new Set([...entries.keys()].filter((raw) => typeof raw === 'number').map(String))
	const byValue = new Map<Choice, NormalizedOption>()
	const byId = new Map<string, NormalizedOption>()
	const groups = new Map<string, NormalizedOption[]>()
	const loose: NormalizedOption[] = []
	for (const [raw, entry] of entries) {
		let id = String(raw)
		// Mantine accepts string IDs. Text-entry controls also display those IDs, so keep
		// natural spellings and quote only a string that collides with a number or the empty selection.
		if (typeof raw === 'string' && (raw === '' || numbers.has(raw))) {
			do {
				id = JSON.stringify(id)
			} while (spellings.has(id))
			spellings.add(id)
		}
		const option: NormalizedOption = {
			...entry,
			raw,
			value: id,
			label: entry.label ?? meta.labels?.[raw] ?? id,
			disabled: entry.disabled ?? disabled.has(raw),
		}
		byValue.set(raw, option)
		byId.set(id, option)
		if (entry.group) {
			const group = groups.get(entry.group) ?? []
			group.push(option)
			groups.set(entry.group, group)
		} else {
			loose.push(option)
		}
	}
	const data = [...Array.from(groups, ([group, items]) => ({ group, items })), ...loose]
	return { byValue, byId, data, flat: [...Array.from(groups.values()).flat(), ...loose], numeric }
}

export function PicklistControl({
	node,
	multiple,
	maxValues,
	value,
	onChange,
	onBlur,
	disabled,
	required,
	ariaLabel,
	id: inputId,
	name,
	'aria-invalid': ariaInvalid,
	'aria-describedby': ariaDescribedBy,
	error,
}: PicklistControlProps) {
	const accessibilityProps = {
		id: inputId,
		'aria-invalid': ariaInvalid,
		'aria-describedby': ariaDescribedBy,
	}
	const inputAccessibilityProps = {
		id: inputId,
		error: error || ariaInvalid,
		errorProps: { id: ariaDescribedBy, style: { whiteSpace: 'pre-line' as const } },
		attributes: { input: { 'aria-invalid': ariaInvalid, 'aria-describedby': ariaDescribedBy } },
	}
	const choices = useMemo(() => normalizeOptions(node, value), [node, value])
	const singleValue = isChoice(value) ? choices.byValue.get(value)?.value : undefined
	const multiValue = Array.isArray(value)
		? value.filter(isChoice).map((item) => choices.byValue.get(item)!.value)
		: []
	const typedValue = (text: string): Choice | null => {
		const known = choices.byId.get(text)
		if (known) return known.raw
		const trimmed = text.trim()
		if (!trimmed) return null
		const number = Number(trimmed)
		return choices.numeric && Number.isFinite(number) ? number : trimmed
	}
	const select = (id: string | null) => onChange(id === null ? null : choices.byId.get(id)!.raw)
	const searchable = node.searchable ?? (node.options?.length ?? 0) >= 8
	const clearable = node.clearable ?? !required
	const dropdown = { withinPortal: true, position: 'bottom-start' as const }
	const renderOption = ({ option }: { option: { value: string; label: string } }) => {
		const detail = choices.byId.get(option.value)
		return (
			<div>
				<Text fw={500} size="sm" c={detail?.accentColor ? `${detail.accentColor}.6` : undefined}>
					{option.label}
				</Text>
				{detail?.description ? (
					<Text size="xs" c="dimmed">
						{detail.description}
					</Text>
				) : null}
			</div>
		)
	}

	const nothingFound = node.emptyLabel ?? (searchable ? '无匹配项' : undefined)

	if (multiple) {
		const limit = maxValues === undefined ? node.max : Math.min(maxValues, node.max ?? Infinity)
		if (node.create) {
			return (
				<TagsInput
					{...inputAccessibilityProps}
					name={name}
					data={choices.flat}
					value={multiValue}
					onChange={(ids) => onChange(ids.map(typedValue).filter(isChoice))}
					onBlur={onBlur}
					clearable={clearable}
					maxTags={limit}
					placeholder={node.placeholder}
					disabled={disabled}
					comboboxProps={dropdown}
					maxDropdownHeight={280}
					aria-label={ariaLabel}
				/>
			)
		}
		return (
			<MultiSelect
				{...inputAccessibilityProps}
				name={name}
				data={choices.data}
				value={multiValue}
				onChange={(ids: string[]) => onChange(ids.map((id) => choices.byId.get(id)!.raw))}
				onBlur={onBlur}
				aria-label={ariaLabel}
				searchable={searchable}
				clearable={clearable}
				hidePickedOptions
				withScrollArea
				comboboxProps={dropdown}
				maxDropdownHeight={280}
				placeholder={node.placeholder}
				disabled={disabled}
				maxValues={limit}
				nothingFoundMessage={nothingFound}
				renderOption={renderOption}
			/>
		)
	}

	if (node.control === 'segmented') {
		return (
			<div {...accessibilityProps} role="group" aria-label={ariaLabel}>
				<SegmentedButtons
					data={choices.flat}
					value={singleValue ?? null}
					onChange={select}
					onBlur={onBlur}
					fullWidth
					disabled={disabled}
				/>
			</div>
		)
	}

	if (node.control === 'radio') {
		return (
			<Radio.Group
				{...accessibilityProps}
				name={name}
				value={singleValue ?? null}
				onChange={select}
				onBlur={onBlur}
				aria-label={ariaLabel}
				{...(disabled !== undefined && { disabled })}
			>
				<Stack gap={6} mt="xs">
					{choices.flat.map((option) => (
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

	if (node.create) {
		// Autocomplete writes its selected label back into the textbox. Use the same
		// unambiguous text for selection and free entry, independently of display metadata.
		return (
			<Autocomplete
				{...inputAccessibilityProps}
				name={name}
				data={choices.flat.map((option) => ({ value: option.value, disabled: option.disabled }))}
				value={singleValue ?? ''}
				onChange={(next) => onChange(typedValue(next))}
				onBlur={onBlur}
				placeholder={node.placeholder}
				disabled={disabled}
				clearable={clearable}
				comboboxProps={dropdown}
				maxDropdownHeight={280}
				aria-label={ariaLabel}
			/>
		)
	}

	return (
		<Select
			{...inputAccessibilityProps}
			name={name}
			data={choices.data}
			value={singleValue ?? null}
			onChange={select}
			onBlur={onBlur}
			aria-label={ariaLabel}
			searchable={searchable}
			clearable={clearable}
			comboboxProps={dropdown}
			placeholder={node.placeholder}
			disabled={disabled}
			nothingFoundMessage={nothingFound}
			renderOption={renderOption}
		/>
	)
}
