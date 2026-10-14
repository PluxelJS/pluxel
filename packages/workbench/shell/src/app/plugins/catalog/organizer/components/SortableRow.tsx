import { CatalogTooltip } from '../../components/CatalogTooltip'
import { useSortable } from '@dnd-kit/sortable'
import {
	ActionIcon,
	Anchor,
	Box,
	Text,
	useComputedColorScheme,
	useMantineTheme,
	rgba,
} from '@mantine/core'
import { IconAlertTriangle, IconCheck, IconSquare, IconGripVertical } from '@tabler/icons-react'
import type { UniqueIdentifier } from '@dnd-kit/core'
import {
	memo,
	type ComponentPropsWithoutRef,
	type ComponentType,
	type MouseEvent,
	type ReactNode,
} from 'react'
import type { PluginPresentationTone } from '../../../pluginExecutionPresentation'
import type { RowDensity } from '../constants'

export type RowMeta = {
	failureLabel?: string
	failureDescription?: string
	definition?: string
	exportName?: string
	reference?: string
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
	const rowGap = dh.rowH <= 26 ? 4 : 6
	const handleSize = dh.rowH <= 26 ? 16 : 20
	const handleIconSize = dh.rowH <= 26 ? 14 : 16

	const rowBackground = active
		? 'var(--plx-selected-bg)'
		: selected
			? 'var(--plx-selected-inactive-bg)'
			: undefined
	const rowColorValue = 'var(--plx-text)'
	const separatorColor = 'color-mix(in srgb, var(--plx-panel-border) 84%, transparent)'
	const statusLabel =
		meta?.failureLabel ??
		(available === false ? '不可用' : running ? '运行中' : desiredRunning ? '等待运行' : '已停止')
	const statusColor = meta?.failureLabel
		? rgba(theme.colors.red[6], 0.8)
		: running
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

	const executionLabel = meta?.executionLabel?.trim() ?? ''
	const recentUpdateWarningLabel = meta?.recentUpdateWarningLabel?.trim() ?? ''
	const nameDescription = name

	const href = `/plugins/${pid}`

	return (
		<Box
			ref={setNodeRef}
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
				aria-pressed={selected}
				data-selected={selected || undefined}
				onClick={(event) => {
					event.preventDefault()
					event.stopPropagation()
					onSelect(event, pid, 'toggle')
				}}
			>
				{selected ? <IconCheck size={11} stroke={2.2} /> : <IconSquare size={11} />}
			</ActionIcon>

			<Box style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
				{LinkComp ? (
					<LinkComp
						to={href}
						data-plugin-link="true"
						style={{
							textDecoration: 'none',
							display: 'block',
							color: rowColorValue,
							minWidth: 0,
							flex: 1,
						}}
						onClick={(e: any) => {
							e.stopPropagation()
							if (e.shiftKey || e.metaKey || e.ctrlKey) {
								e.preventDefault()
								onSelect(e, pid, 'click')
							}
						}}
					>
						<CatalogTooltip
							label={nameDescription}
							multiline
							maw={440}
							events={{ hover: true, focus: true, touch: false }}
							withinPortal
							withArrow
						>
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
						</CatalogTooltip>
					</LinkComp>
				) : (
					<CatalogTooltip
						label={nameDescription}
						multiline
						maw={440}
						events={{ hover: true, focus: true, touch: false }}
						withinPortal
						withArrow
					>
						<Anchor
							size={dh.font}
							href={href}
							underline="never"
							data-plugin-link="true"
							style={{
								flex: 1,
								minWidth: 0,
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
					</CatalogTooltip>
				)}
			</Box>

			{recentUpdateWarningLabel ? (
				<CatalogTooltip
					label={meta?.recentUpdateWarningDescription ?? recentUpdateWarningLabel}
					withinPortal
					withArrow
				>
					<Text
						component="span"
						c={meta?.recentUpdateWarningTone ?? 'yellow'}
						aria-label={recentUpdateWarningLabel}
						style={{ display: 'inline-flex', flexShrink: 0 }}
					>
						<IconAlertTriangle size={12} stroke={2.2} aria-hidden="true" />
					</Text>
				</CatalogTooltip>
			) : null}

			{executionLabel ? (
				<CatalogTooltip
					label={`${executionLabel}${meta?.executionDescription ? ` · ${meta.executionDescription}` : ''}`}
					multiline
					maw={360}
					events={{ hover: true, focus: true, touch: false }}
					withinPortal
					withArrow
				>
					<Text
						component="span"
						c={meta?.executionTone ?? 'gray'}
						className="plx-pluginCatalog__executionIndicator"
						aria-label={executionLabel}
						role="img"
						tabIndex={0}
					>
						<span aria-hidden="true" />
					</Text>
				</CatalogTooltip>
			) : null}

			{typeof running === 'boolean' && (
				<CatalogTooltip
					label={
						meta?.failureDescription ? `${statusLabel} · ${meta.failureDescription}` : statusLabel
					}
					withinPortal
					withArrow

					events={{ hover: true, focus: true, touch: false }}
				>
					<Box
						component="span"
						aria-label={statusLabel}
						role="img"
						tabIndex={0}
						className="plx-pluginCatalog__statusIndicator"
						style={{ color: statusColor }}
					>
						<span aria-hidden="true" />
					</Box>
				</CatalogTooltip>
			)}
		</Box>
	)
}

const areRowPropsEqual = (prev: SortableRowProps, next: SortableRowProps) => {
	if (
		prev.meta?.failureLabel !== next.meta?.failureLabel ||
		prev.meta?.failureDescription !== next.meta?.failureDescription
	)
		return false
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
	if (prev.meta?.exportName !== next.meta?.exportName) return false
	if (prev.meta?.reference !== next.meta?.reference) return false
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
