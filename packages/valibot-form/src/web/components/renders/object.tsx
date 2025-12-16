import {
	ActionIcon,
	Badge,
	Card,
	Collapse,
	Group,
	Stack,
	Text,
	useMantineTheme,
} from '@mantine/core'
import { IconChevronDown, IconChevronRight } from '@tabler/icons-react'
import { useCallback, useMemo, useState } from 'react'
import { DEFAULT_GRID_COLUMNS, GRID_COLUMN_THRESHOLD } from '~/core/constants'
import type { CommonProps } from '~/core/registry'
import { MetaRenderer, registerRenderer } from '~/core/registry'
import { META_MAP } from '~/core/utils'
import { FieldChrome } from '../shared'
import { cleanProps } from '../../utils/propHelpers'
import { cachedExtractInfo } from '../schemaCache'
import { alignToCss, countCompactFields, resolveFieldSpan } from '../layout'

type RendererProps = CommonProps<typeof META_MAP.object>

interface ChildInfo {
	name: string
	info: NonNullable<ReturnType<typeof cachedExtractInfo>>
}

function ObjectField(props: RendererProps) {
	const { formBaseInfo, extractedPropsInfo, errors, value, inputProps } = props
	const theme = useMantineTheme()
	const [collapsed, setCollapsed] = useState(extractedPropsInfo.collapse === true)

	// 规范化 value
	const objectValue = useMemo(() => (value && typeof value === 'object' ? value : {}), [value])

	// 提取子字段信息（带缓存）
	const childInfos = useMemo<ChildInfo[]>(() => {
		return extractedPropsInfo.fields
			.map((field) => {
				const info = cachedExtractInfo(field.schema as any, field.name)
				if (!info || info.formInfo.hidden) return null
				return { name: field.name, info }
			})
			.filter((item): item is ChildInfo => item !== null)
	}, [extractedPropsInfo.fields])

	// 分离基础错误和子字段错误
	const baseErrors = useMemo(
		() => (errors ?? []).filter((err) => err.dotPath.length <= 1).map((err) => err.message),
		[errors],
	)

	const childErrors = useMemo(() => {
		const map = new Map<string, RendererProps['errors']>()
		for (const err of errors ?? []) {
			if (err.dotPath.length <= 1) continue
			const [, childKey, ...rest] = err.dotPath
			if (!childKey) continue
			const nextPath = rest.length ? [childKey, ...rest] : [childKey]
			map.set(childKey, [...(map.get(childKey) ?? []), { ...err, dotPath: nextPath }])
		}
		return map
	}, [errors])

	// 布局配置
	const variant = extractedPropsInfo.variant ?? 'card'
	const compactCount = countCompactFields(childInfos.map((c) => ({ type: c.info.type })))
	const columns = Math.max(
		1,
		Math.min(
			extractedPropsInfo.columns ??
				(compactCount >= GRID_COLUMN_THRESHOLD ? DEFAULT_GRID_COLUMNS : 1),
			4,
		),
	)
	const gapValue = extractedPropsInfo.gap ?? theme.spacing.lg

	// 性能优化：使用 useCallback 缓存构建子字段 props 的函数
	const buildChildInputProps = useCallback(
		(fieldName: string) => {
			const nestedName = inputProps.name ? `${inputProps.name}.${fieldName}` : fieldName
			return {
				name: nestedName,
				onChange: (nextValue: unknown) => {
					if (inputProps.disabled) return
					inputProps.onChange?.({ ...objectValue, [fieldName]: nextValue })
				},
				onBlur: () => {
					if (inputProps.disabled) return
					inputProps.onBlur?.({ target: { name: nestedName } } as any)
				},
				disabled: inputProps.disabled,
				readOnly: inputProps.readOnly,
			}
		},
		[inputProps, objectValue],
	)

	// 渲染子字段
	const renderedChildren = useMemo(
		() =>
			childInfos.map((child) => {
				const errorsForChild = childErrors.get(child.name) ?? []
				const childDisabled = Boolean(inputProps.disabled || child.info.formInfo.disabled)
				const childReadOnly = Boolean(inputProps.readOnly || child.info.formInfo.readOnly)

				const childInput = buildChildInputProps(child.name)
				childInput.disabled = childDisabled
				childInput.readOnly = childReadOnly

				const span = resolveFieldSpan(columns, child.info.formInfo.layout, child.info.type)
				const align = alignToCss(child.info.formInfo.layout?.align)

				return (
					<div key={child.name} style={{ gridColumn: `span ${span}`, alignSelf: align }}>
						<MetaRenderer
							type={child.info.type}
							formBaseInfo={
								{ ...child.info.formInfo, disabled: childDisabled, readOnly: childReadOnly } as any
							}
							extractedPropsInfo={child.info.props}
							errors={errorsForChild}
							value={objectValue[child.name]}
							inputProps={childInput as any}
						/>
					</div>
				)
			}),
		[
			childInfos,
			childErrors,
			inputProps.disabled,
			inputProps.readOnly,
			buildChildInputProps,
			columns,
			objectValue,
		],
	)

	// 构建内容
	const content = renderedChildren.length ? (
		columns === 1 ? (
			<Stack gap={gapValue}>{renderedChildren}</Stack>
		) : (
			<div
				style={{
					display: 'grid',
					gap: gapValue,
					gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
					alignItems: 'end', // 底部对齐，让不同高度的字段视觉上更协调
				}}
			>
				{renderedChildren}
			</div>
		)
	) : (
		<Text size="sm" c="dimmed">
			暂无子字段
		</Text>
	)

	// Card 变体的标题和折叠功能
	const headerLabel = formBaseInfo.label ?? '字段组'
	const headerNode = (
		<Group justify="space-between" align="center" mb="sm">
			<Group gap={6}>
				<Text fw={600}>
					{headerLabel}
					{formBaseInfo.required && (
						<Text span c="red">
							{' '}
							*
						</Text>
					)}
				</Text>
				{formBaseInfo.badge && (
					<Badge
						variant="light"
						size="sm"
						color={typeof formBaseInfo.badge === 'string' ? undefined : formBaseInfo.badge.color}
					>
						{typeof formBaseInfo.badge === 'string' ? formBaseInfo.badge : formBaseInfo.badge.label}
					</Badge>
				)}
			</Group>
			{extractedPropsInfo.collapse !== undefined && (
				<ActionIcon
					variant="subtle"
					size="sm"
					onClick={() => setCollapsed(!collapsed)}
					aria-label={collapsed ? '展开' : '折叠'}
				>
					{collapsed ? <IconChevronRight size={16} /> : <IconChevronDown size={16} />}
				</ActionIcon>
			)}
		</Group>
	)

	// stack 变体：不渲染 Card，直接输出内容
	if (variant === 'stack') {
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
				{content}
			</FieldChrome>
		)
	}

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
				hideLabel: true,
				hideRequired: formBaseInfo.hideRequired,
			})}
		>
			<Card withBorder radius="md" p="md">
				{headerNode}
				{formBaseInfo.description && (
					<Text size="sm" c="dimmed" mb="sm">
						{formBaseInfo.description}
					</Text>
				)}
				<Collapse in={!collapsed}>{content}</Collapse>
			</Card>
		</FieldChrome>
	)
}

registerRenderer(META_MAP.object, (props: any) => <ObjectField {...props} />)
