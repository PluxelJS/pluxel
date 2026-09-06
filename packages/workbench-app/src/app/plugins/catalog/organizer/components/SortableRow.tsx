import { useSortable } from '@dnd-kit/sortable'
import {
	ActionIcon,
	Anchor,
	Badge,
	Box,
	Group,
	Text,
	Tooltip,
	useComputedColorScheme,
	useMantineTheme,
	rgba,
} from '@mantine/core'
import { IconAlertTriangle, IconCheck, IconGripVertical } from '@tabler/icons-react'
import type { UniqueIdentifier } from '@dnd-kit/core'
import {
	memo,
	useMemo,
	type ComponentPropsWithoutRef,
	type ComponentType,
	type MouseEvent,
	type ReactNode,
} from 'react'
import type { PluginPresentationTone } from '../../../pluginExecutionPresentation'
import type { RowDensity } from '../constants'

export type RowMeta = {
	definition?: string
	executionLabel?: string
	executionTone?: PluginPresentationTone
	executionDescription?: string
	recentUpdateWarningLabel?: string
	recentUpdateWarningTone?: PluginPresentationTone
	recentUpdateWarningDescription?: string
}
type LinkLikeProps = {
	to: string
	children: ReactNode
} & Omit<ComponentPropsWithoutRef<'a'>, 'href'>

export type SortableRowProps = {
	pid: string
	name: string
	running?: boolean
	available?: boolean
	desiredRunning?: boolean
	selected: boolean
	active: boolean
	focused: boolean
	onSelect: (e: MouseEvent, pid: string, mode?: 'click' | 'context' | 'toggle') => void
	LinkComp?: ComponentType<LinkLikeProps>
	dragDisabled: boolean
	dh: RowDensity
	meta?: RowMeta
	sortableId: UniqueIdentifier
}

const SortableRowComponent = ({
	pid,
	name,
	running,
	available,
	desiredRunning,
	selected,
	active,
	focused,
	onSelect,
	LinkComp,
	dragDisabled,
	dh,
	meta,
	sortableId,
}: SortableRowProps) => {
	const theme = useMantineTheme()
	const scheme = useComputedColorScheme('light', { getInitialValueInEffect: true })
	const isDark = scheme === 'dark'
	const brand = theme.colors.brand ?? theme.colors.indigo
	const showStatusLabel = dh.rowH >= 30
	const rowGap = dh.rowH <= 26 ? 4 : 6
	const handleSize = dh.rowH <= 26 ? 16 : 20
	const handleIconSize = dh.rowH <= 26 ? 14 : 16

	const activeBg = active ? (isDark ? rgba(brand[6], 0.2) : rgba(brand[1], 0.9)) : undefined
	const selectedBg = selected ? (isDark ? rgba(brand[5], 0.12) : rgba(brand[0], 0.92)) : undefined
	const rowBackground = active ? activeBg : selected ? selectedBg : undefined
	const rowColorValue = 'var(--plx-text)'
	const metaColorValue = active ? 'var(--plx-accent-strong)' : 'var(--plx-text-muted)'
	const separatorColor = 'color-mix(in srgb, var(--plx-panel-border) 84%, transparent)'
	const statusLabel =
		available === false ? '不可用' : running ? '运行中' : desiredRunning ? '等待运行' : '已停止'
	const statusColor = running
		? isDark
			? rgba(theme.colors.teal[4], 0.85)
			: rgba(theme.colors.teal[6], 0.8)
		: available === false
			? rgba(theme.colors.red[6], 0.8)
			: desiredRunning
				? rgba(theme.colors.yellow[6], 0.8)
				: 'color-mix(in srgb, var(--plx-text-muted) 88%, transparent)'

	const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
		id: sortableId,
		disabled: dragDisabled,
		animateLayoutChanges: () => false,
	})

	const metaLabel = useMemo(() => {
		return meta?.definition?.trim() ?? ''
	}, [meta?.definition])
	const executionLabel = meta?.executionLabel?.trim() ?? ''
	const recentUpdateWarningLabel = meta?.recentUpdateWarningLabel?.trim() ?? ''

	const href = `/plugins/${pid}`

	return (
		<Box
			ref={setNodeRef}
			onDoubleClick={(e) => {
				const link = (e.currentTarget as HTMLElement).querySelector(
					'[data-plugin-link]',
				) as HTMLElement | null
				link?.click?.()
			}}
			onClick={(e) => {
				const isModified = e.shiftKey || e.metaKey || e.ctrlKey
				if (isModified) {
					e.preventDefault()
					onSelect(e, pid, 'click')
					return
				}
				const target = e.target as HTMLElement | null
				if (target?.closest('[data-drag-handle]')) return
				const link = (e.currentTarget as HTMLElement).querySelector(
					'[data-plugin-link]',
				) as HTMLElement | null
				link?.click?.()
			}}
			onContextMenu={(e) => {
				e.preventDefault()
				e.stopPropagation()
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
				borderRadius: 8,
				cursor: 'pointer',
				userSelect: 'none',
				background: rowBackground,
				color: rowColorValue,
				borderBottom: `1px solid ${separatorColor}`,
				boxSizing: 'border-box',
			}}
			className="plx-pluginCatalog__row"
			data-po-row="1"
			data-plugin-id={pid}
			data-selected={selected || undefined}
			data-active={active || undefined}
			data-focused={focused || undefined}
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
					cursor: dragDisabled ? 'default' : isDragging ? 'grabbing' : 'grab',
				}}
				{...listeners}
				{...attributes}
				disabled={dragDisabled}
			>
				<IconGripVertical size={handleIconSize} />
			</ActionIcon>

			<ActionIcon
				variant="transparent"
				title={selected ? '取消选择' : '加入选择'}
				aria-label={selected ? `取消选择 ${name}` : `选择 ${name}`}
				className="plx-pluginCatalog__rowSelector"
				data-row-selector="true"
				data-selected={selected || undefined}
				onClick={(event) => {
					event.preventDefault()
					event.stopPropagation()
					onSelect(event, pid, 'toggle')
				}}
			>
				<IconCheck size={11} stroke={2.2} />
			</ActionIcon>

			<Box style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
				{LinkComp ? (
					<LinkComp
						to={href}
						data-plugin-link="true"
						style={{ textDecoration: 'none', display: 'block', color: rowColorValue, minWidth: 0 }}
						onClick={(e: any) => {
							e.stopPropagation()
							if (e.shiftKey || e.metaKey || e.ctrlKey) {
								e.preventDefault()
								onSelect(e, pid, 'click')
							}
						}}
					>
						<Tooltip label={name} withinPortal withArrow openDelay={200}>
							<Text
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
							size={dh.font}
							href={href}
							underline="never"
							data-plugin-link="true"
							style={{
								whiteSpace: 'nowrap',
								overflow: 'hidden',
								textOverflow: 'ellipsis',
								color: rowColorValue,
							}}
							aria-current={active ? 'page' : undefined}
							onClick={(e) => {
								e.stopPropagation()
								if (e.shiftKey || e.metaKey || e.ctrlKey) {
									e.preventDefault()
									onSelect(e, pid, 'click')
								}
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
							whiteSpace: 'nowrap',
							flexShrink: 0,
							maxWidth: 120,
							overflow: 'hidden',
							textOverflow: 'ellipsis',
							color: metaColorValue,
						}}
					>
						{metaLabel}
					</Text>
				)}
			</Box>

			{recentUpdateWarningLabel ? (
				<Tooltip
					label={meta?.recentUpdateWarningDescription ?? recentUpdateWarningLabel}
					withinPortal
					withArrow
					openDelay={200}
				>
					<Text
						component="span"
						c={meta?.recentUpdateWarningTone ?? 'yellow'}
						aria-label={recentUpdateWarningLabel}
						style={{ display: 'inline-flex', flexShrink: 0 }}
					>
						<IconAlertTriangle size={12} stroke={2.2} aria-hidden="true" />
					</Text>
				</Tooltip>
			) : null}

			{executionLabel ? (
				<Tooltip
					label={meta?.executionDescription ?? executionLabel}
					withinPortal
					withArrow
					openDelay={200}
				>
					<Badge
						size="xs"
						variant="light"
						color={meta?.executionTone ?? 'gray'}
						style={{ flexShrink: 0, textTransform: 'none' }}
					>
						{executionLabel}
					</Badge>
				</Tooltip>
			) : null}

			{typeof running === 'boolean' && (
				<Group gap={showStatusLabel ? 6 : 4} wrap="nowrap" aria-label={statusLabel}>
					<Tooltip
						label={statusLabel}
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
								background: statusColor,
							}}
						/>
					</Tooltip>
					{showStatusLabel && (
						<Text size="xs" style={{ color: rowColorValue }}>
							{statusLabel}
						</Text>
					)}
				</Group>
			)}
		</Box>
	)
}

const areRowPropsEqual = (prev: SortableRowProps, next: SortableRowProps) => {
	if (prev.pid !== next.pid) return false
	if (prev.name !== next.name) return false
	if (prev.running !== next.running) return false
	if (prev.available !== next.available) return false
	if (prev.desiredRunning !== next.desiredRunning) return false
	if (prev.selected !== next.selected) return false
	if (prev.active !== next.active) return false
	if (prev.focused !== next.focused) return false
	if (prev.dragDisabled !== next.dragDisabled) return false
	if (prev.sortableId !== next.sortableId) return false
	if (prev.LinkComp !== next.LinkComp) return false
	if (prev.onSelect !== next.onSelect) return false
	if (prev.dh.rowH !== next.dh.rowH) return false
	if (prev.dh.px !== next.dh.px) return false
	if (prev.dh.py !== next.dh.py) return false
	if (prev.dh.font !== next.dh.font) return false
	if (prev.meta?.definition !== next.meta?.definition) return false
	if (prev.meta?.executionLabel !== next.meta?.executionLabel) return false
	if (prev.meta?.executionTone !== next.meta?.executionTone) return false
	if (prev.meta?.executionDescription !== next.meta?.executionDescription) return false
	if (prev.meta?.recentUpdateWarningLabel !== next.meta?.recentUpdateWarningLabel) return false
	if (prev.meta?.recentUpdateWarningTone !== next.meta?.recentUpdateWarningTone) return false
	if (prev.meta?.recentUpdateWarningDescription !== next.meta?.recentUpdateWarningDescription) {
		return false
	}
	return true
}

export const SortableRow = memo(SortableRowComponent, areRowPropsEqual)
