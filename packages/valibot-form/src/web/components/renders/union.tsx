import { Card, Radio, Select, Stack, Switch, Text } from '@mantine/core'
import { useContext, useMemo, useRef, useState, type ChangeEvent } from 'react'
import type { UnionBranch, UnionFieldNode } from '../../../core/fields'
import { cleanProps } from '../../utils/propHelpers'
import { FormResetVersion } from '../internal/formContext'
import { UnionSelectionContext } from '../internal/unionSelectionContext'
import { useFieldRenderer, useValueRenderer } from '../internal/fieldRendererContext'
import { hasProtectedValue, isProtectedField } from '../internal/fieldProtection'
import { isRecord, matchingUnionBranches, unionBranchLiteral } from '../../../core/fieldInput'
import { SegmentedButtons } from '../SegmentedButtons'
import { FieldChrome } from '../chrome/FieldChrome'
import { normalizeErrorMessages, type RendererProps, triggerFormEvents } from './types'

const truthySet = new Set<unknown>([true, 'true', 1, '1'])

function humanizeBranchLabel(value: UnionBranch['discriminatorValue'], index: number) {
	if (value === true) return '开启'
	if (value === false) return '关闭'
	if (value === null || value === undefined) return `选项 ${index + 1}`
	const str = String(value)
	return str.charAt(0).toUpperCase() + str.slice(1)
}

function branchDraft(
	branch: UnionBranch | undefined,
	value: unknown,
	sharedKeys: ReadonlySet<string>,
	discriminator: string | undefined,
): unknown {
	if (branch?.fields.some((field) => field.replaceValue)) return value
	return isRecord(value)
		? Object.fromEntries(
				Object.entries(value).filter(([key]) => key !== discriminator && !sharedKeys.has(key)),
			)
		: undefined
}

function missingProtectedInput(
	node: UnionBranch['fields'][number]['node'],
	value: unknown,
): boolean {
	if (value === undefined && !node.required) return false
	if (isProtectedField(node)) return value === undefined
	return (
		node.kind === 'object' &&
		value !== null &&
		node.fields.some((field) =>
			missingProtectedInput(
				field,
				isRecord(value) && field.name !== undefined ? value[field.name] : undefined,
			),
		)
	)
}

function renderEmptyBranch() {
	return (
		<Card withBorder p="md" bg="var(--mantine-color-default-hover)">
			<Text size="sm" c="dimmed" ta="center">
				此选项无需额外配置
			</Text>
		</Card>
	)
}

export function UnionField(props: RendererProps) {
	const resetVersion = useContext(FormResetVersion)
	const node = props.node as UnionFieldNode
	// Drafts belong to the editable branch structure. Equivalent projections,
	// labels and current array indices can change without ending that session.
	const { discriminator, branches, sharedFields, preserve } = node
	const shape = useMemo(
		() =>
			JSON.stringify(
				[discriminator, preserve !== false, branches, sharedFields],
				[
					'key',
					'discriminatorValue',
					'replaceValue',
					'node',
					'name',
					'kind',
					'literal',
					'options',
					'fields',
					'item',
					'value',
					'branches',
					'sharedFields',
					'discriminator',
					'discriminatorField',
					'required',
					'nullable',
					'meta',
					'hidden',
					'disabled',
					'readOnly',
				],
			),
		[discriminator, preserve, branches, sharedFields],
	)
	return <UnionEditor key={`${resetVersion}:${shape}`} {...props} node={node} />
}

function UnionEditor(props: RendererProps<UnionFieldNode>) {
	const { node, errors, inputProps, value, path } = props
	const renderField = useFieldRenderer()
	const renderValue = useValueRenderer()
	const initializeParentUnion = useContext(UnionSelectionContext)
	const { branches, discriminator, sharedFields, labels, descriptions } = node
	const candidates = useMemo(() => matchingUnionBranches(node, value), [node, value])
	const matchingIndex = candidates.length === 1 ? branches.indexOf(candidates[0]!) : -1
	const truthyBranchIndex = branches.findIndex((branch) => truthySet.has(branch.discriminatorValue))
	const falsyBranchIndex = branches.findIndex((branch) => !truthySet.has(branch.discriminatorValue))
	const resolvedControl =
		node.control === 'switch' &&
		((matchingIndex < 0 && discriminator !== undefined) ||
			branches.length !== 2 ||
			truthyBranchIndex < 0 ||
			falsyBranchIndex < 0)
			? 'select'
			: node.control
	const preserveBranchValues = node.preserve !== false
	const exposeDiscriminator = node.expose ?? 'auto'
	const isLocked = Boolean(inputProps.disabled || inputProps.readOnly)

	const branchCache = useRef(new Map<number, unknown>())
	const sharedKeys = useMemo(() => new Set(sharedFields.map(({ key }) => key)), [sharedFields])
	const [chosenBranchIndex, setSelectedBranchIndex] = useState<number | null>(null)
	const [switchError, setSwitchError] = useState<string>()
	const fallback = branches[chosenBranchIndex ?? 0]
	const selectedBranch =
		candidates.find((branch) => branch === fallback) ?? candidates[0] ?? fallback
	const selectedBranchIndex = selectedBranch ? branches.indexOf(selectedBranch) : -1
	const selectorValue =
		matchingIndex < 0 && (discriminator !== undefined || chosenBranchIndex === null)
			? null
			: String(selectedBranchIndex)

	const shouldRenderDiscriminatorField =
		Boolean(node.discriminatorField) &&
		exposeDiscriminator !== 'never' &&
		(resolvedControl === 'switch' || exposeDiscriminator === 'always')
	const shouldRenderSelector = resolvedControl !== 'switch' || !shouldRenderDiscriminatorField

	const branchOptions = branches.map((branch, index) => {
		const optionValue = branch.discriminatorValue
		const numericTwin =
			typeof optionValue === 'string' &&
			branches.some(
				({ discriminatorValue }) =>
					typeof discriminatorValue === 'number' && String(discriminatorValue) === optionValue,
			)
		return {
			value: String(index),
			label:
				labels?.[branch.key] ??
				(numericTwin ? JSON.stringify(optionValue) : humanizeBranchLabel(optionValue, index)),
			description: descriptions?.[branch.key],
		}
	})

	const selectBranch = (targetIndex: number) => {
		const target = branches[targetIndex]
		if (isLocked || !target || targetIndex === matchingIndex) return

		const currentDraft = branchDraft(selectedBranch, value, sharedKeys, discriminator)
		const sameBranch = targetIndex === selectedBranchIndex
		if (!sameBranch && hasProtectedValue(node, value)) {
			setSwitchError('当前选项包含受保护的值，无法切换。')
			return
		}

		const targetDraft = sameBranch ? currentDraft : branchCache.current.get(targetIndex)
		const replacement = target.fields.find((field) => field.replaceValue)
		let next = targetDraft
		if (replacement) {
			if (next === undefined) next = unionBranchLiteral(target)
			if (missingProtectedInput(replacement.node, next)) {
				setSwitchError('目标选项缺少必填的只读值，无法切换。')
				return
			}
		} else {
			const common = isRecord(value)
				? Object.fromEntries(Object.entries(value).filter(([key]) => sharedKeys.has(key)))
				: {}
			const fields = {
				...common,
				...(isRecord(targetDraft) ? targetDraft : {}),
				...(discriminator !== undefined && target.discriminatorValue !== undefined
					? { [discriminator]: target.discriminatorValue }
					: {}),
			}
			if (
				[...sharedFields, ...target.fields].some((field) =>
					missingProtectedInput(field.node, fields[field.key]),
				)
			) {
				setSwitchError('目标选项缺少必填的只读值，无法切换。')
				return
			}
			next = fields
		}

		setSwitchError(undefined)
		if (preserveBranchValues && !sameBranch)
			branchCache.current.set(selectedBranchIndex, currentDraft)
		setSelectedBranchIndex(targetIndex)
		triggerFormEvents(inputProps, next, { blur: true })
	}
	const handleSelectorChange = (index: string | null) => {
		if (index !== null) selectBranch(Number(index))
	}
	const handleBooleanToggle = (checked: boolean) =>
		selectBranch(checked ? truthyBranchIndex : falsyBranchIndex)

	const replacementOwnsErrors = selectedBranch?.fields.some(
		(field) => field.replaceValue && !field.node.meta.hidden,
	)
	const baseErrors = replacementOwnsErrors ? [] : normalizeErrorMessages(errors)

	const selectorAccessibility = {
		id: inputProps.id,
		'aria-label': node.meta.label,
		'aria-invalid': inputProps['aria-invalid'],
		'aria-describedby': inputProps['aria-describedby'],
	}
	const selectorInputAccessibility = {
		id: inputProps.id,
		'aria-label': node.meta.label,
		error: inputProps['aria-invalid'],
		attributes: {
			input: {
				'aria-invalid': inputProps['aria-invalid'],
				'aria-describedby': inputProps['aria-describedby'],
			},
		},
	}

	const selectorNode = (() => {
		if (!shouldRenderSelector) return null
		if (branches.length === 0) return null
		switch (resolvedControl) {
			case 'segmented':
				return (
					<div {...selectorAccessibility} role="group">
						<SegmentedButtons
							data={branchOptions}
							value={selectorValue ?? ''}
							onChange={handleSelectorChange}
							onBlur={inputProps.onBlur}
							disabled={isLocked}
							fullWidth
						/>
					</div>
				)
			case 'radio':
				return (
					<Radio.Group
						{...selectorAccessibility}
						{...cleanProps({
							value: selectorValue ?? '',
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
						{...selectorInputAccessibility}
						{...cleanProps({
							checked: selectorValue !== null && truthySet.has(selectedBranch?.discriminatorValue),
							onChange: (event: ChangeEvent<HTMLInputElement>) =>
								handleBooleanToggle(event.currentTarget.checked),
							label: truthySet.has(selectedBranch?.discriminatorValue)
								? (branchOptions[truthyBranchIndex]?.label ?? '开启')
								: (branchOptions[falsyBranchIndex]?.label ?? '关闭'),
							onBlur: inputProps.onBlur,
							disabled: isLocked,
						})}
					/>
				)
			default:
				return (
					<Select
						{...selectorInputAccessibility}
						{...cleanProps({
							data: branchOptions,
							value: selectorValue,
							allowDeselect: false,
							onChange: handleSelectorChange,
							placeholder: node.placeholder ?? '选择类型',
							searchable: node.searchable,
							onBlur: inputProps.onBlur,
							disabled: isLocked,
						})}
					/>
				)
		}
	})()

	const alwaysVisibleFields = useMemo(() => {
		const fields = [...sharedFields]
		if (shouldRenderDiscriminatorField && discriminator && node.discriminatorField) {
			fields.unshift(node.discriminatorField)
		}
		const seen = new Set<string>()
		return fields.filter((field) => {
			if (!field.key) return false
			if (seen.has(field.key)) return false
			seen.add(field.key)
			return true
		})
	}, [sharedFields, shouldRenderDiscriminatorField, discriminator, node.discriminatorField])

	// Initialization belongs to this union; descendants still perform their own
	// FieldApi operation. The guard prevents repeated parent initialization in
	// nested unions before React renders the newly established discriminator.
	const initializeSelection = useMemo(() => {
		const branchValue = selectedBranch?.discriminatorValue
		if (discriminator === undefined || branchValue === undefined || matchingIndex >= 0)
			return initializeParentUnion
		let initializedSelection = false
		return () => {
			initializeParentUnion?.()
			if (initializedSelection) return
			initializedSelection = true
			triggerFormEvents(inputProps, {
				...(isRecord(value) ? value : {}),
				[discriminator]: branchValue,
			})
		}
	}, [
		initializeParentUnion,
		inputProps,
		value,
		discriminator,
		matchingIndex,
		selectedBranch?.discriminatorValue,
	])

	const sharedFieldsNode =
		alwaysVisibleFields.length === 0 ? null : (
			<Stack gap="sm">
				{alwaysVisibleFields.map((field) => (
					<div key={field.key}>
						{renderField({
							node: field.node,
							path: [...path, field.key],
							disabled: inputProps.disabled,
							readOnly: inputProps.readOnly,
							onChange:
								field.key === discriminator
									? (nextValue: unknown) => {
											selectBranch(
												branches.findIndex((branch) => branch.discriminatorValue === nextValue),
											)
										}
									: undefined,
						})}
					</div>
				))}
			</Stack>
		)

	const branchFieldsNode = (() => {
		if (!selectedBranch?.fields?.length) return node.compact ? null : renderEmptyBranch()
		const fieldsContent = (
			<Stack gap="sm" key={selectedBranchIndex}>
				{selectedBranch.fields.map((field) => (
					<div key={field.key}>
						{field.replaceValue
							? field.node.meta.hidden
								? null
								: renderValue({
										...props,
										node: field.node,
										inputProps: {
											...inputProps,
											disabled: Boolean(inputProps.disabled || field.node.meta.disabled),
											readOnly: Boolean(inputProps.readOnly || field.node.meta.readOnly),
											...(isProtectedField(field.node)
												? { onChange: undefined, onBlur: undefined }
												: {}),
										},
									})
							: renderField({
									node: field.node,
									path: [...path, field.key],
									onChange: undefined,
									disabled: inputProps.disabled,
									readOnly: inputProps.readOnly,
								})}
					</div>
				))}
			</Stack>
		)
		return node.compact ? (
			fieldsContent
		) : (
			<Card withBorder p="md">
				{fieldsContent}
			</Card>
		)
	})()

	return (
		<FieldChrome
			errorId={inputProps.errorId}
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
			<UnionSelectionContext.Provider value={initializeSelection}>
				<Stack gap="md">
					{shouldRenderSelector && selectorNode}
					{switchError ? (
						<Text role="status" size="sm" c="dimmed">
							{switchError}
						</Text>
					) : null}
					{sharedFieldsNode}
					{branchFieldsNode}
				</Stack>
			</UnionSelectionContext.Provider>
		</FieldChrome>
	)
}
