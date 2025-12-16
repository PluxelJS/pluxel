import { Card, Checkbox, Radio, SegmentedControl, Select, Stack, Switch, Text } from '@mantine/core'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { UnionMetaResult } from '~/core/actions/union'
import type { CommonProps } from '~/core/registry'
import { MetaRenderer, registerRenderer, triggerFormEvents } from '~/core/registry'
import { META_MAP } from '~/core/utils'
import { cleanProps } from '../../utils/propHelpers'
import { FieldChrome } from '../shared'
import { cachedExtractInfo } from '../schemaCache'

type RendererProps = CommonProps<typeof META_MAP.union> & { value?: unknown }
type Branch = UnionMetaResult['branches'][number]
type FieldRef = {
	key: string
	schema: any
	extracted?: ReturnType<typeof cachedExtractInfo> | null
	replaceBranchValue?: boolean
}

const booleanVariants = new Set<UnionMetaResult['resolvedVariant']>(['switch', 'checkbox'])
const truthySet = new Set<unknown>([true, 'true', 1, '1'])

const isObject = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === 'object'

function normalizeBranchKey(value: Branch['discriminatorValue'], index: number) {
	if (value === null || value === undefined) return `branch_${index}`
	if (typeof value === 'boolean') return value ? 'true' : 'false'
	return String(value)
}

function humanizeBranchLabel(value: Branch['discriminatorValue'], index: number) {
	if (value === true) return '开启'
	if (value === false) return '关闭'
	if (value === null || value === undefined) return `选项 ${index + 1}`
	const str = String(value)
	return str.charAt(0).toUpperCase() + str.slice(1)
}

function findMatchingBranchIndex(
	branches: Branch[],
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

function collectNonBranchKeys(sharedFields: FieldRef[], discriminator?: string) {
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
	branches: Branch[]
	currentValue: unknown
	discriminator?: string
	explicitDiscriminator?: Branch['discriminatorValue']
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

	if (!cache.has(targetIndex)) {
		for (const [key, val] of Object.entries(currentObj)) {
			if (nonBranchKeys.has(key)) continue
			if (key === discriminator) continue
			if (!(key in next)) next[key] = val
		}
	}

	return next
}

function isTruthyDiscriminator(value: Branch['discriminatorValue']) {
	return truthySet.has(value as unknown)
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

function UnionField(props: RendererProps) {
	const { formBaseInfo, errors, extractedPropsInfo, inputProps, value, fieldName } = props
	const ep = extractedPropsInfo ?? ({} as UnionMetaResult)
	const branches = ep.branches ?? []
	const discriminator = ep.discriminator
	const sharedFields = ep.sharedFields ?? []
	const resolvedVariant = ep.resolvedVariant ?? 'select'
	const branchLabels = ep.branchLabels ?? {}
	const branchDescriptions = ep.branchDescriptions ?? {}
	const preserveBranchValues = ep.preserveBranchValues !== false
	const exposeDiscriminator = ep.exposeDiscriminator ?? 'auto'

	const discriminatorExtracted = useMemo(
		() =>
			discriminator && ep.discriminatorSchema
				? cachedExtractInfo(ep.discriminatorSchema, {}, discriminator)
				: null,
		[discriminator, ep.discriminatorSchema],
	)

	const branchCacheRef = useRef(new Map<number, Record<string, unknown>>())

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

	const selectedBranch = branches[selectedBranchIndex]

	const shouldRenderDiscriminatorField =
		Boolean(discriminatorExtracted) &&
		exposeDiscriminator !== 'never' &&
		(booleanVariants.has(resolvedVariant) || exposeDiscriminator === 'always')
	const shouldRenderSelector =
		!booleanVariants.has(resolvedVariant) || !shouldRenderDiscriminatorField

	const branchOptions = useMemo(
		() =>
			branches.map((branch, index) => {
				const key = normalizeBranchKey(branch.discriminatorValue, index)
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
		explicitValue?: Branch['discriminatorValue'],
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
		triggerFormEvents(inputProps, nextValue)
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
				? (branches[truthyBranchIndex]?.discriminatorValue ?? true)
				: (branches[falsyBranchIndex]?.discriminatorValue ?? false))
		snapshotAndSetBranch(targetIndex, explicitValue)
	}

	const baseErrors = (errors ?? [])
		.filter((err) => err.dotPath.length <= 1)
		.map((err) => err.message)

	const selectorNode = (() => {
		if (!shouldRenderSelector) return null
		if (!branches.length) return null
		switch (resolvedVariant) {
			case 'segmented':
				return (
					<SegmentedControl
						{...cleanProps({
							data: branchOptions,
							value: String(selectedBranchIndex),
							onChange: handleSelectorChange,
							disabled: inputProps.disabled,
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
						})}
					>
						<Stack gap="xs">
							{branchOptions.map((opt) => (
								<Radio
									key={opt.value}
									value={opt.value}
									label={opt.label}
									description={ep.showBranchDescription ? opt.description : undefined}
									disabled={inputProps.disabled}
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
								? (branchOptions[truthyBranchIndex]?.label ?? '开启')
								: (branchOptions[falsyBranchIndex]?.label ?? '关闭'),
							disabled: inputProps.disabled,
						})}
					/>
				)
			case 'checkbox':
				return (
					<Checkbox
						{...cleanProps({
							checked: isTruthyDiscriminator(selectedBranch?.discriminatorValue),
							onChange: (event) => handleBooleanToggle(event.currentTarget.checked),
							label: isTruthyDiscriminator(selectedBranch?.discriminatorValue)
								? (branchOptions[truthyBranchIndex]?.label ?? '开启')
								: (branchOptions[falsyBranchIndex]?.label ?? '关闭'),
							disabled: inputProps.disabled,
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
							placeholder: ep.placeholder ?? '选择类型',
							searchable: ep.searchable,
							disabled: inputProps.disabled,
						})}
					/>
				)
		}
	})()

	const alwaysVisibleFields: FieldRef[] = useMemo(() => {
		const fields: FieldRef[] = [...sharedFields]
		if (shouldRenderDiscriminatorField && discriminator && ep.discriminatorSchema) {
			fields.unshift({
				key: discriminator,
				schema: ep.discriminatorSchema,
				extracted: discriminatorExtracted,
			})
		}
		const seen = new Set<string>()
		return fields.filter((field) => {
			if (!field.key) return false
			if (seen.has(field.key)) return false
			seen.add(field.key)
			return true
		})
	}, [
		sharedFields,
		shouldRenderDiscriminatorField,
		discriminator,
		ep.discriminatorSchema,
		discriminatorExtracted,
	])

	const sharedFieldsNode =
		alwaysVisibleFields.length === 0 ? null : (
			<Stack gap="md">
				{alwaysVisibleFields.map((field) => {
					const fieldKey = field.key
					const extracted = field.extracted ?? cachedExtractInfo(field.schema, {}, fieldKey)
					if (!extracted) return null
					const fieldErrors = (errors ?? [])
						.filter((err) => err.dotPath.length > 1 && err.dotPath[1] === fieldKey)
						.map((err) => ({ ...err, dotPath: err.dotPath.slice(1) }))
					const fieldValue = isObject(value)
						? (value as Record<string, unknown>)[fieldKey]
						: undefined
					return (
						<MetaRenderer
							key={fieldKey}
							type={extracted.type}
							fieldName={fieldKey}
							formBaseInfo={extracted.formInfo}
							extractedPropsInfo={extracted.props}
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
											newFieldValue as Branch['discriminatorValue'],
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

	const branchFields = useMemo(() => {
		if (!selectedBranch?.schema) return [] as FieldRef[]
		const extracted = cachedExtractInfo(
			selectedBranch.schema,
			{},
			`${fieldName ?? 'union'}_branch_${selectedBranchIndex}`,
		)
		if (!extracted) return [] as FieldRef[]

		if (extracted.type === 'object') {
			const fields = ((extracted.props as any).fields ?? []) as Array<{
				name?: string
				key?: string
				schema: any
			}>
			return fields
				.map((field) => ({ key: field.name ?? field.key ?? '', schema: field.schema }))
				.filter((field) => field.key && !nonBranchKeys.has(field.key))
		}

		const fallbackKey =
			(typeof fieldName === 'string' && fieldName) ||
			(typeof discriminator === 'string' ? discriminator : 'value')
		return [
			{ key: fallbackKey, schema: selectedBranch.schema, extracted, replaceBranchValue: true },
		]
	}, [selectedBranch, fieldName, selectedBranchIndex, nonBranchKeys, discriminator])

	const branchFieldsNode = useMemo(() => {
		if (branchFields.length === 0) return ep.compact ? null : renderEmptyBranch()

		const fieldsContent = (
			<Stack gap="md">
				{branchFields.map((field) => {
					const fieldKey = field.key
					const extracted = field.extracted ?? cachedExtractInfo(field.schema, {}, fieldKey)
					if (!extracted) return null

					const fieldErrors = field.replaceBranchValue
						? (errors ?? [])
						: (errors ?? [])
								.filter((err) => err.dotPath.length > 1 && err.dotPath[1] === fieldKey)
								.map((err) => ({
									...err,
									dotPath: err.dotPath.slice(1),
								}))
					const fieldValue = field.replaceBranchValue
						? value
						: isObject(value)
							? (value as Record<string, unknown>)[fieldKey]
							: undefined

					return (
						<MetaRenderer
							key={fieldKey}
							type={extracted.type}
							fieldName={fieldKey}
							formBaseInfo={extracted.formInfo}
							extractedPropsInfo={extracted.props}
							value={fieldValue}
							errors={fieldErrors}
							inputProps={{
								...inputProps,
								name: inputProps.name ? `${inputProps.name}.${fieldKey}` : fieldKey,
								onChange: (event: any) => {
									const newFieldValue = event?.target?.value ?? event
									if (field.replaceBranchValue) {
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

		// 紧凑模式不渲染 Card 边框
		return ep.compact ? (
			fieldsContent
		) : (
			<Card withBorder p="md">
				{fieldsContent}
			</Card>
		)
	}, [
		branchFields,
		errors,
		value,
		inputProps,
		discriminator,
		selectedBranch,
		ep.compact,
		nonBranchKeys,
	])

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
				hideLabel: formBaseInfo.hideLabel,
				hideRequired: formBaseInfo.hideRequired,
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

registerRenderer(META_MAP.union, (props) => <UnionField {...(props as RendererProps)} />)
