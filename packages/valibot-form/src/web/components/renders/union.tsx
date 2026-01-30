import { Card, Radio, SegmentedControl, Select, Stack, Switch, Text } from '@mantine/core'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { UnionBranch, UnionFieldNode } from '../../../core/fields'
import { FieldRenderer } from '../internal/FieldRenderer'
import { cleanProps } from '../../utils/propHelpers'
import { FieldChrome } from '../shared'
import {
	isErrorWithPath,
	normalizeErrorMessages,
	type FieldError,
	type RendererProps,
	triggerFormEvents,
} from './types'

const booleanVariants = new Set<UnionFieldNode['control']>(['switch'])
const truthySet = new Set<unknown>([true, 'true', 1, '1'])

const isObject = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === 'object'

function normalizeBranchKey(value: UnionBranch['discriminatorValue'], index: number) {
	if (value === null || value === undefined) return `branch_${index}`
	if (typeof value === 'boolean') return value ? 'true' : 'false'
	return String(value)
}

function humanizeBranchLabel(value: UnionBranch['discriminatorValue'], index: number) {
	if (value === true) return '开启'
	if (value === false) return '关闭'
	if (value === null || value === undefined) return `选项 ${index + 1}`
	const str = String(value)
	return str.charAt(0).toUpperCase() + str.slice(1)
}

function isTruthyDiscriminator(value: UnionBranch['discriminatorValue']) {
	return truthySet.has(value as unknown)
}

function findMatchingBranchIndex(
	branches: UnionBranch[],
	value: unknown,
	discriminator?: string,
	fallback = 0,
) {
	if (!branches.length) return fallback
	if (!discriminator || !isObject(value)) return fallback
	const discValue = value[discriminator]
	const idx = branches.findIndex((b) => b.discriminatorValue === discValue)
	if (idx >= 0) return idx
	if (typeof discValue === 'boolean') {
		const truthyIdx = branches.findIndex((b) => isTruthyDiscriminator(b.discriminatorValue))
		const falsyIdx = branches.findIndex((b) => !isTruthyDiscriminator(b.discriminatorValue))
		return discValue ? (truthyIdx >= 0 ? truthyIdx : fallback) : falsyIdx >= 0 ? falsyIdx : fallback
	}
	return fallback
}

function collectNonBranchKeys(sharedFields: UnionFieldNode['sharedFields'], discriminator?: string) {
	const set = new Set<string>()
	for (const field of sharedFields) {
		if (field.key) set.add(field.key)
	}
	if (discriminator) set.add(discriminator)
	return set
}

function snapshotBranchValue(
	cache: Map<number, Record<string, unknown>>,
	index: number,
	value: unknown,
	nonBranchKeys: Set<string>,
	enabled: boolean,
) {
	if (!enabled || !isObject(value)) return
	const snapshot: Record<string, unknown> = {}
	for (const [key, val] of Object.entries(value)) {
		if (nonBranchKeys.has(key)) continue
		snapshot[key] = val
	}
	cache.set(index, snapshot)
}

function buildNextValue(args: {
	targetIndex: number
	branches: UnionBranch[]
	currentValue: unknown
	discriminator?: string
	explicitDiscriminator?: UnionBranch['discriminatorValue']
	nonBranchKeys: Set<string>
	cache: Map<number, Record<string, unknown>>
	preserveBranchValues: boolean
}) {
	const {
		targetIndex,
		branches,
		currentValue,
		discriminator,
		explicitDiscriminator,
		nonBranchKeys,
		cache,
		preserveBranchValues,
	} = args

	const next: Record<string, unknown> = {}
	const currentObj = isObject(currentValue) ? currentValue : {}

	for (const key of nonBranchKeys) {
		if (key === discriminator) continue
		if (key in currentObj) next[key] = currentObj[key]
	}

	const branch = branches[targetIndex]
	const discValue =
		explicitDiscriminator ??
		branch?.discriminatorValue ??
		(discriminator ? currentObj[discriminator] : null)
	if (discriminator && discValue !== null && discValue !== undefined) {
		next[discriminator] = discValue
	}

	if (preserveBranchValues) {
		const cached = cache.get(targetIndex)
		if (cached) Object.assign(next, cached)
	}

	if (preserveBranchValues && !cache.has(targetIndex)) {
		for (const [key, val] of Object.entries(currentObj)) {
			if (nonBranchKeys.has(key)) continue
			if (key === discriminator) continue
			if (!(key in next)) next[key] = val
		}
	}

	return next
}

function renderEmptyBranch() {
	return (
		<Card withBorder p="md" style={{ backgroundColor: 'var(--mantine-color-gray-0)' }}>
			<Text size="sm" c="dimmed" ta="center">
				此选项无需额外配置
			</Text>
		</Card>
	)
}

export function UnionField(props: RendererProps) {
	const { node, errors, inputProps, value } = props
	const info = node as UnionFieldNode
	const branches = info.branches ?? []
	const discriminator = info.discriminator
	const sharedFields = info.sharedFields ?? []
	const resolvedControl = info.control ?? 'select'
	const branchLabels = info.labels ?? {}
	const branchDescriptions = info.descriptions ?? {}
	const preserveBranchValues = info.preserve !== false
	const exposeDiscriminator = info.expose ?? 'auto'
	const isLocked = Boolean(inputProps.disabled || inputProps.readOnly)

	const branchCacheRef = useRef(new Map<number, Record<string, unknown>>())

	const branchSignature = useMemo(
		() =>
			branches
				.map((branch, index) => {
					const key = branch.key ?? normalizeBranchKey(branch.discriminatorValue, index)
					return `${key}:${String(branch.discriminatorValue)}`
				})
				.join('|'),
		[branches],
	)
	const sharedSignature = useMemo(
		() => sharedFields.map((field) => field.key).filter(Boolean).join('|'),
		[sharedFields],
	)

	const nonBranchKeys = useMemo(
		() => collectNonBranchKeys(sharedFields, discriminator),
		[sharedFields, discriminator],
	)

	const [selectedBranchIndex, setSelectedBranchIndex] = useState(() =>
		findMatchingBranchIndex(branches, value, discriminator),
	)

	useEffect(() => {
		setSelectedBranchIndex((current) =>
			findMatchingBranchIndex(branches, value, discriminator, current),
		)
	}, [branches, value, discriminator])

	useEffect(() => {
		branchCacheRef.current = new Map()
	}, [branchSignature, sharedSignature, discriminator, preserveBranchValues])

	const selectedBranch = branches[selectedBranchIndex]

	const shouldRenderDiscriminatorField =
		Boolean(info.discriminatorField) &&
		exposeDiscriminator !== 'never' &&
		(booleanVariants.has(resolvedControl) || exposeDiscriminator === 'always')
	const shouldRenderSelector = !booleanVariants.has(resolvedControl) || !shouldRenderDiscriminatorField

	const branchOptions = useMemo(
		() =>
			branches.map((branch, index) => {
				const key = branch.key ?? normalizeBranchKey(branch.discriminatorValue, index)
				const label =
					branchLabels[key as keyof typeof branchLabels] ??
					humanizeBranchLabel(branch.discriminatorValue, index)
				return {
					value: String(index),
					label,
					description: branchDescriptions[key as keyof typeof branchDescriptions],
				}
			}),
		[branches, branchLabels, branchDescriptions],
	)

	const truthyBranchIndex = useMemo(
		() => branches.findIndex((branch) => isTruthyDiscriminator(branch.discriminatorValue)),
		[branches],
	)
	const falsyBranchIndex = useMemo(
		() => branches.findIndex((branch) => !isTruthyDiscriminator(branch.discriminatorValue)),
		[branches],
	)

	const snapshotAndSetBranch = (
		targetIndex: number,
		explicitValue?: UnionBranch['discriminatorValue'],
	) => {
		if (targetIndex < 0 || targetIndex >= branches.length) return
		snapshotBranchValue(
			branchCacheRef.current,
			selectedBranchIndex,
			value,
			nonBranchKeys,
			preserveBranchValues,
		)
		const nextValue = buildNextValue({
			targetIndex,
			branches,
			currentValue: value,
			discriminator,
			explicitDiscriminator: explicitValue,
			nonBranchKeys,
			cache: branchCacheRef.current,
			preserveBranchValues,
		})
		setSelectedBranchIndex(targetIndex)
		triggerFormEvents(inputProps, nextValue, { blur: true })
	}

	const handleSelectorChange = (newIndexStr: string | null) => {
		if (newIndexStr === null) return
		const newIndex = Number(newIndexStr)
		if (Number.isNaN(newIndex)) return
		snapshotAndSetBranch(newIndex)
	}

	const handleBooleanToggle = (checked: boolean) => {
		const targetIndex = checked
			? truthyBranchIndex >= 0
				? truthyBranchIndex
				: selectedBranchIndex
			: falsyBranchIndex >= 0
				? falsyBranchIndex
				: selectedBranchIndex
		const branch = branches[targetIndex]
		const explicitValue =
			branch?.discriminatorValue ??
			(checked
				? branches[truthyBranchIndex]?.discriminatorValue ?? true
				: branches[falsyBranchIndex]?.discriminatorValue ?? false)
		snapshotAndSetBranch(targetIndex, explicitValue)
	}

	const errorBuckets = useMemo(() => {
		const base: FieldError[] = []
		const map = new Map<string, FieldError[]>()
		for (const err of errors ?? []) {
			if (!isErrorWithPath(err) || (err.dotPath?.length ?? 0) <= 1) {
				base.push(err)
				continue
			}
			const key = String(err.dotPath?.[1])
			if (!map.has(key)) map.set(key, [])
			map.get(key)!.push({ ...err, dotPath: err.dotPath?.slice(1) })
		}
		return { base: normalizeErrorMessages(base), map }
	}, [errors])

	const baseErrors = errorBuckets.base

	const selectorNode = (() => {
		if (!shouldRenderSelector) return null
		if (!branches.length) return null
		switch (resolvedControl) {
			case 'segmented':
				return (
					<SegmentedControl
						{...cleanProps({
							data: branchOptions,
							value: String(selectedBranchIndex),
							onChange: handleSelectorChange,
							onBlur: inputProps.onBlur,
							disabled: isLocked,
							fullWidth: true,
						})}
					/>
				)
			case 'radio':
				return (
					<Radio.Group
						{...cleanProps({
							value: String(selectedBranchIndex),
							onChange: handleSelectorChange,
							onBlur: inputProps.onBlur,
						})}
					>
						<Stack gap="xs">
							{branchOptions.map((opt) => (
								<Radio
									key={opt.value}
									value={opt.value}
									label={opt.label}
									description={opt.description}
									disabled={isLocked}
								/>
							))}
						</Stack>
					</Radio.Group>
				)
			case 'switch':
				return (
					<Switch
						{...cleanProps({
							checked: isTruthyDiscriminator(selectedBranch?.discriminatorValue),
							onChange: (event) => handleBooleanToggle(event.currentTarget.checked),
							label: isTruthyDiscriminator(selectedBranch?.discriminatorValue)
								? branchOptions[truthyBranchIndex]?.label ?? '开启'
								: branchOptions[falsyBranchIndex]?.label ?? '关闭',
							onBlur: inputProps.onBlur,
							disabled: isLocked,
						})}
					/>
				)
			default:
				return (
					<Select
						{...cleanProps({
							data: branchOptions,
							value: String(selectedBranchIndex),
							onChange: handleSelectorChange,
							placeholder: info.placeholder ?? '选择类型',
							searchable: info.searchable,
							onBlur: inputProps.onBlur,
							disabled: isLocked,
						})}
					/>
				)
		}
	})()

	const alwaysVisibleFields = useMemo(() => {
		const fields = [...sharedFields]
		if (shouldRenderDiscriminatorField && discriminator && info.discriminatorField) {
			fields.unshift(info.discriminatorField)
		}
		const seen = new Set<string>()
		return fields.filter((field) => {
			if (!field.key) return false
			if (seen.has(field.key)) return false
			seen.add(field.key)
			return true
		})
	}, [sharedFields, shouldRenderDiscriminatorField, discriminator, info.discriminatorField])

	const sharedFieldsNode =
		alwaysVisibleFields.length === 0 ? null : (
			<Stack gap="sm">
				{alwaysVisibleFields.map((field) => {
					const fieldKey = field.key
					const fieldErrors = errorBuckets.map.get(fieldKey) ?? []
					const fieldValue = isObject(value)
						? (value as Record<string, unknown>)[fieldKey]
						: undefined
					return (
						<FieldRenderer
							key={fieldKey}
							node={field.node}
							value={fieldValue}
							errors={fieldErrors}
							inputProps={{
								...inputProps,
								name: inputProps.name ? `${inputProps.name}.${fieldKey}` : fieldKey,
								onChange: (event: any) => {
									const newFieldValue = event?.target?.value ?? event
									if (fieldKey === discriminator) {
										const nextCandidate = isObject(value)
											? { ...value, [fieldKey]: newFieldValue }
											: { [fieldKey]: newFieldValue }
										snapshotAndSetBranch(
											findMatchingBranchIndex(
												branches,
												nextCandidate,
												discriminator,
												selectedBranchIndex,
											),
											newFieldValue as UnionBranch['discriminatorValue'],
										)
										return
									}
									const currentValue = isObject(value) ? (value as Record<string, unknown>) : {}
									const nextValue: Record<string, unknown> = {
										...currentValue,
										[fieldKey]: newFieldValue,
									}
									if (
										discriminator &&
										selectedBranch?.discriminatorValue !== null &&
										selectedBranch?.discriminatorValue !== undefined
									) {
										nextValue[discriminator] = selectedBranch.discriminatorValue
									}
									triggerFormEvents(inputProps, nextValue)
								},
							}}
						/>
					)
				})}
			</Stack>
		)

	const branchFieldsNode = useMemo(() => {
		if (!selectedBranch?.fields?.length) return info.compact ? null : renderEmptyBranch()

		const fieldsContent = (
			<Stack gap="sm">
				{selectedBranch.fields.map((field) => {
					const fieldKey = field.key
					const fieldErrors = field.replaceValue ? (errors ?? []) : errorBuckets.map.get(fieldKey) ?? []
					const fieldValue = field.replaceValue
						? value
						: isObject(value)
							? (value as Record<string, unknown>)[fieldKey]
							: undefined

					return (
						<FieldRenderer
							key={fieldKey}
							node={field.node}
							value={fieldValue}
							errors={fieldErrors}
							inputProps={{
								...inputProps,
								name: inputProps.name ? `${inputProps.name}.${fieldKey}` : fieldKey,
								onChange: (event: any) => {
									const newFieldValue = event?.target?.value ?? event
									if (field.replaceValue) {
										const currentValue = isObject(value) ? (value as Record<string, unknown>) : {}
										const baseValue: Record<string, unknown> = isObject(newFieldValue)
											? { ...(newFieldValue as Record<string, unknown>) }
											: { [fieldKey]: newFieldValue }

										for (const key of nonBranchKeys) {
											if (key === discriminator) continue
											if (key in currentValue && !(key in baseValue)) {
												baseValue[key] = currentValue[key]
											}
										}

										if (
											discriminator &&
											selectedBranch?.discriminatorValue !== null &&
											selectedBranch?.discriminatorValue !== undefined
										) {
											baseValue[discriminator] = selectedBranch.discriminatorValue
										}

										triggerFormEvents(inputProps, baseValue)
									} else {
										const currentValue = isObject(value) ? (value as Record<string, unknown>) : {}
										const nextValue: Record<string, unknown> = {
											...currentValue,
											[fieldKey]: newFieldValue,
										}
										if (
											discriminator &&
											selectedBranch?.discriminatorValue !== null &&
											selectedBranch?.discriminatorValue !== undefined
										) {
											nextValue[discriminator] = selectedBranch.discriminatorValue
										}
										triggerFormEvents(inputProps, nextValue)
									}
								},
							}}
						/>
					)
				})}
			</Stack>
		)

		return info.compact ? fieldsContent : <Card withBorder p="md">{fieldsContent}</Card>
	}, [selectedBranch, errors, value, inputProps, discriminator, nonBranchKeys, info.compact])

	return (
		<FieldChrome
			{...cleanProps({
				label: node.meta.label,
				required: node.required,
				description: node.meta.description,
				help: node.meta.help,
				hint: node.meta.hint,
				badge: node.meta.badge,
				errors: baseErrors,
				hideLabel: node.meta.hideLabel,
				hideRequired: node.meta.hideRequired,
			})}
		>
			<Stack gap="md">
				{shouldRenderSelector && selectorNode}
				{sharedFieldsNode}
				{branchFieldsNode}
			</Stack>
		</FieldChrome>
	)
}
