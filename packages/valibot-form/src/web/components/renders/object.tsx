import { ActionIcon, Card, Collapse, Group, Stack, Text } from '@mantine/core'
import { IconChevronDown, IconChevronRight } from '@tabler/icons-react'
import { useMemo, useState } from 'react'
import type { FieldNode, ObjectFieldNode } from '../../../core/fields'
import { FieldRenderer } from '../internal/FieldRenderer'
import { alignToCss, resolveFieldSpan } from '../internal/layout'
import { planFieldSections } from '../internal/fieldPlanner'
import {
	isErrorWithPath,
	joinErrorMessages,
	normalizeErrorMessages,
	type FieldError,
	type RendererProps,
	triggerFormEvents,
} from './types'

const isObjectValue = (value: unknown): value is Record<string, unknown> =>
	Boolean(value) && typeof value === 'object'

export function ObjectField(props: RendererProps) {
	const { node, errors, inputProps, value } = props
	const info = node as ObjectFieldNode
	const baseErrors = normalizeErrorMessages(
		errors?.filter((err) => typeof err !== 'object' || (err as any)?.dotPath?.length <= 1),
	)

	const fieldErrorsMap = useMemo(() => {
		const map = new Map<string, FieldError[]>()
		for (const err of errors ?? []) {
			if (!isErrorWithPath(err)) continue
			if ((err.dotPath?.length ?? 0) <= 1) continue
			const key = String(err.dotPath?.[1])
			if (!map.has(key)) map.set(key, [])
			map.get(key)!.push({ ...err, dotPath: err.dotPath?.slice(1) })
		}
		return map
	}, [errors])

	const sections = useMemo(() => planFieldSections(info.fields), [info.fields])
	const [collapsed, setCollapsed] = useState(Boolean(info.collapsible && info.collapsed))

	const renderField = (field: FieldNode) => {
		if (!field.name) return null
		const fieldValue = isObjectValue(value) ? value[field.name] : undefined
		const fieldErrors = fieldErrorsMap.get(field.name) ?? []
		const nestedName = inputProps.name ? `${inputProps.name}.${field.name}` : field.name
		return (
			<FieldRenderer
				key={field.name}
				node={field}
				value={fieldValue}
				errors={fieldErrors}
				inputProps={{
					name: nestedName,
					onChange: (nextValue: unknown) => {
						const current = isObjectValue(value) ? value : {}
						const next = { ...current, [field.name!]: nextValue }
						triggerFormEvents(inputProps, next)
					},
					onBlur: () => inputProps.onBlur?.({ target: { name: nestedName } } as any),
					disabled: inputProps.disabled || field.meta.disabled,
					readOnly: inputProps.readOnly || field.meta.readOnly,
				}}
			/>
		)
	}

	const content = (
		<Stack gap={info.gap ?? 'md'}>
			{sections.hiddenFields.map((field) => (
				<div key={`hidden-${field.name}`} style={{ display: 'none' }}>
					{renderField(field.node)}
				</div>
			))}
			{sections.sections.map((section) => (
				<Stack key={section.id} gap="sm">
					{section.title || section.description ? (
						<Stack gap={4}>
							{section.title ? <Text fw={600}>{section.title}</Text> : null}
							{section.description ? (
								<Text size="sm" c="dimmed">
									{section.description}
								</Text>
							) : null}
						</Stack>
					) : null}
					<div
						style={{
							display: 'grid',
							gridTemplateColumns: `repeat(${section.columns}, minmax(0, 1fr))`,
							gap: 'var(--mantine-spacing-md)',
						}}
					>
						{section.fields.map(({ name, node: field }) => {
							const span = resolveFieldSpan(section.columns, field.meta.layout, field.kind)
							return (
								<div
									key={name}
									style={{
										gridColumn: `span ${Math.min(span, section.columns)}`,
										alignSelf: alignToCss(field.meta.layout?.align),
									}}
								>
									{renderField(field)}
								</div>
							)
						})}
					</div>
				</Stack>
			))}
		</Stack>
	)

	const header = node.meta.hideLabel ? null : (
		<Group justify="space-between" align="center" wrap="nowrap">
			<Group gap={8} align="center">
				<Text fw={600}>{node.meta.label}</Text>
				{info.collapsible ? (
					<ActionIcon
						variant="subtle"
						onClick={() => setCollapsed((prev) => !prev)}
						aria-label={collapsed ? '展开' : '折叠'}
						type="button"
					>
						{collapsed ? <IconChevronRight size={16} /> : <IconChevronDown size={16} />}
					</ActionIcon>
				) : null}
			</Group>
			{node.meta.badge ? (
				<Text size="sm" c="dimmed">
					{typeof node.meta.badge === 'string' ? node.meta.badge : node.meta.badge.label}
				</Text>
			) : null}
		</Group>
	)

	if (info.variant === 'stack') {
		return (
			<Stack gap="sm">
				{node.meta.description ? (
					<Text size="sm" c="dimmed">
						{node.meta.description}
					</Text>
				) : null}
				{info.collapsible ? <Collapse expanded={!collapsed}>{content}</Collapse> : content}
			</Stack>
		)
	}

	return (
		<Card withBorder shadow="xs" p="md">
			<Stack gap="sm">
				{header}
				{node.meta.description ? (
					<Text size="sm" c="dimmed">
						{node.meta.description}
					</Text>
				) : null}
				{baseErrors.length > 0 ? (
					<Text size="sm" c="red.6" style={{ whiteSpace: 'pre-line' }}>
						{joinErrorMessages(baseErrors)}
					</Text>
				) : null}
				{info.collapsible ? <Collapse expanded={!collapsed}>{content}</Collapse> : content}
				{node.meta.help ? (
					<Text size="sm" c="dimmed">
						{node.meta.help}
					</Text>
				) : null}
			</Stack>
		</Card>
	)
}
