import { useSortable } from '@dnd-kit/sortable'
import {
	ActionIcon,
	Anchor,
	Box,
	Group,
	Text,
	Tooltip,
	useComputedColorScheme,
	useMantineTheme,
	rgba,
} from '@mantine/core'
import { IconGripVertical } from '@tabler/icons-react'
import type { UniqueIdentifier } from '@dnd-kit/core'
import type React from 'react'
import { useMemo, useRef } from 'react'
import type { RowDensity } from '../constants'

type RowMeta = { tag?: string; version?: string }

export type SortableRowProps = {
	pid: string
	name: string
	running?: boolean
	enabled?: boolean
	selected: boolean
	active: boolean
	onSelect: (e: React.MouseEvent, pid: string, mode?: 'click' | 'context') => void
	LinkComp?: React.ComponentType<{ to: string; children: React.ReactNode }>
	disabled: boolean
	dh: RowDensity
	meta?: RowMeta
	sortableId: UniqueIdentifier
}

export function SortableRow({
	pid,
	name,
	running,
	enabled,
	selected,
	active,
	onSelect,
	LinkComp,
	disabled,
	dh,
	meta,
	sortableId,
}: SortableRowProps) {
	const theme = useMantineTheme()
	const scheme = useComputedColorScheme('light', { getInitialValueInEffect: true })
	const isDark = scheme === 'dark'
	const rowRef = useRef<HTMLAnchorElement | HTMLSpanElement | null>(null)
	const brand = theme.colors.brand ?? theme.colors.indigo
	const accent = theme.colors.blue
	const showStatusLabel = dh.rowH >= 30
	const rowGap = dh.rowH <= 26 ? 4 : 6
	const handleSize = dh.rowH <= 26 ? 16 : 20
	const handleIconSize = dh.rowH <= 26 ? 14 : 16

	// 优化后的配色方案：提升背景可见度，保持文字清晰
	const activeBg = active
		? isDark
			? rgba(brand[5], 0.28)
			: rgba(brand[1], 0.45)
		: undefined
	const selectedBg = selected
		? isDark
			? rgba(accent[5], 0.22)
			: rgba(accent[1], 0.35)
		: undefined
	const rowBackground = active ? activeBg : selected ? selectedBg : undefined
	const baseColorValue = isDark ? theme.colors.gray[2] : theme.colors.gray[8]
	const rowColorValue =
		active || selected
			? isDark
				? theme.colors.gray[0]
				: theme.colors.gray[9]
			: baseColorValue
	const separatorColor = isDark ? rgba(theme.colors.dark[4], 0.3) : rgba(theme.colors.gray[2], 0.5)

	const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
		id: sortableId,
		disabled,
		animateLayoutChanges: () => false,
	})

	const metaLabel = useMemo(() => {
		const tag = meta?.tag?.trim()
		const version = meta?.version?.trim()
		if (tag && version) return `${tag}@${version}`
		if (tag) return tag
		if (version) return version
		return ''
	}, [meta?.tag, meta?.version])

	const href = `/plugins/${encodeURIComponent(pid)}`

	return (
		<Box
			ref={setNodeRef}
			onDoubleClick={() => (rowRef.current as HTMLAnchorElement | null)?.click?.()}
			onClick={(e) => {
				if (disabled) return
				if (e.shiftKey || e.metaKey || e.ctrlKey) e.preventDefault()
				onSelect(e, pid, 'click')
			}}
			onContextMenu={(e) => {
				e.preventDefault()
				e.stopPropagation()
				if (disabled) return
				onSelect(e, pid, 'context')
			}}
			data-plugin-row="true"
			style={{
				transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
				transition: transition ?? 'opacity 120ms ease-out, background 120ms ease-out',
				opacity: isDragging ? 0.9 : 1,
				height: dh.rowH,
				padding: `${dh.py}px ${dh.px}px`,
				display: 'flex',
				alignItems: 'center',
				gap: rowGap,
				borderRadius: 6,
				cursor: disabled ? 'default' : 'pointer',
				userSelect: 'none',
				background: rowBackground,
				color: rowColorValue,
				borderBottom: `1px solid ${separatorColor}`,
				boxSizing: 'border-box',
			}}
			data-po-row="1"
			data-selected={selected || undefined}
			data-active={active || undefined}
			role="listitem"
			aria-roledescription="draggable plugin row"
		>
			{active && (
				<Box
					aria-hidden
					style={{
						width: 2,
						alignSelf: 'stretch',
						background: isDark ? rgba(brand[3], 0.8) : brand[5],
						borderTopLeftRadius: 6,
						borderBottomLeftRadius: 6,
					}}
				/>
			)}

			<ActionIcon
				variant="subtle"
				title="拖拽排序"
				aria-label="拖拽排序"
				data-drag-handle
				style={{
					width: handleSize,
					height: handleSize,
					flex: `0 0 ${handleSize}px`,
					touchAction: 'none',
					cursor: isDragging ? 'grabbing' : 'grab',
				}}
				{...listeners}
				{...attributes}
			>
				<IconGripVertical size={handleIconSize} />
			</ActionIcon>

			<Box style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
				{LinkComp ? (
					<LinkComp
						to={href}
						style={{ textDecoration: 'none', display: 'block', color: rowColorValue, minWidth: 0 }}
						onClick={(e: any) => {
							if (disabled) return
							e.stopPropagation()
							if (e.shiftKey || e.metaKey || e.ctrlKey) e.preventDefault()
							onSelect(e, pid, 'click')
						}}
					>
						<Tooltip label={name} withinPortal withArrow openDelay={200}>
							<Text
								ref={rowRef as any}
								size={dh.font}
								style={{
									whiteSpace: 'nowrap',
									overflow: 'hidden',
									textOverflow: 'ellipsis',
									color: rowColorValue,
								}}
								aria-current={active ? 'page' : undefined}
							>
								{name}
							</Text>
						</Tooltip>
					</LinkComp>
				) : (
					<Tooltip label={name} withinPortal withArrow openDelay={200}>
						<Anchor
							ref={rowRef as any}
							size={dh.font}
							href={href}
							underline="never"
							style={{
								whiteSpace: 'nowrap',
								overflow: 'hidden',
								textOverflow: 'ellipsis',
								color: rowColorValue,
							}}
							aria-current={active ? 'page' : undefined}
							onClick={(e) => {
								if (disabled) return
								e.stopPropagation()
								if (e.shiftKey || e.metaKey || e.ctrlKey) e.preventDefault()
								onSelect(e, pid, 'click')
							}}
						>
							{name}
						</Anchor>
					</Tooltip>
				)}
				{metaLabel && (
					<Text
						size="xs"
						style={{
							fontSize: 10,
							opacity: 0.7,
							whiteSpace: 'nowrap',
							flexShrink: 0,
							maxWidth: 120,
							overflow: 'hidden',
							textOverflow: 'ellipsis',
							color: rowColorValue,
						}}
					>
						{metaLabel}
					</Text>
				)}
			</Box>

			{typeof running === 'boolean' && (
				<Group
					gap={showStatusLabel ? 6 : 4}
					wrap="nowrap"
					aria-label={running ? '运行' : enabled === false ? '禁用' : '停止'}
				>
					<Tooltip
						label={running ? '运行' : enabled === false ? '禁用' : '停止'}
						withinPortal
						withArrow
						disabled={showStatusLabel}
						openDelay={200}
					>
						<Box
							component="span"
							aria-hidden
							style={{
								width: 6,
								height: 6,
								borderRadius: 6,
								background: running
									? isDark
										? rgba(theme.colors.teal[4], 0.85)
										: rgba(theme.colors.teal[6], 0.8)
									: isDark
										? rgba(theme.colors.gray[6], 0.5)
										: rgba(theme.colors.gray[5], 0.6),
							}}
						/>
					</Tooltip>
					{showStatusLabel && (
						<Text size="xs" style={{ color: rowColorValue }}>
							{running ? '运行' : enabled === false ? '禁用' : '停止'}
						</Text>
					)}
				</Group>
			)}
		</Box>
	)
}
