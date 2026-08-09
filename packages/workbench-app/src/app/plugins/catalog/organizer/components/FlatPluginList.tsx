import { Box, Stack, Text } from '@mantine/core'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
	useEffect,
	useMemo,
	useRef,
	type ComponentPropsWithoutRef,
	type ComponentType,
	type MouseEvent,
	type ReactNode,
} from 'react'
import { FLAT_VIRTUAL_OVERSCAN, type RowDensity } from '../constants'
import { iid } from '../controllerModel'
import { SortableRow } from './SortableRow'

type LinkLikeProps = {
	to: string
	children: ReactNode
} & Omit<ComponentPropsWithoutRef<'a'>, 'href'>

type FlatPluginListProps = {
	ids: string[]
	virtualize: boolean
	runningSet: Set<string>
	enabledSet: Set<string>
	selectedSet: Set<string>
	activeSet: Set<string>
	focusedId: string | null
	onSelect: (event: MouseEvent, pluginId: string, mode?: 'click' | 'context' | 'toggle') => void
	LinkComp?: ComponentType<LinkLikeProps>
	getName: (id: string) => string
	getMeta: (id: string) => { tag?: string; version?: string }
	dh: RowDensity
	emptyLabel: string
	listLabel: string
}

export function FlatPluginList({
	ids,
	virtualize,
	runningSet,
	enabledSet,
	selectedSet,
	activeSet,
	focusedId,
	onSelect,
	LinkComp,
	getName,
	getMeta,
	dh,
	emptyLabel,
	listLabel,
}: FlatPluginListProps) {
	const scrollRef = useRef<HTMLDivElement | null>(null)
	const items = useMemo(() => ids.map((id) => ({ id, sortableId: iid(id) })), [ids])
	const focusedIndex = focusedId ? ids.indexOf(focusedId) : -1
	const virtualizer = useVirtualizer({
		count: ids.length,
		getScrollElement: () => scrollRef.current,
		estimateSize: () => dh.rowH,
		overscan: FLAT_VIRTUAL_OVERSCAN,
		enabled: virtualize,
		initialRect: { width: 0, height: Math.max(dh.rowH * 8, 1) },
	})
	const virtualItems = virtualizer.getVirtualItems()
	const fallbackStart = focusedIndex >= 0 ? Math.max(0, focusedIndex - FLAT_VIRTUAL_OVERSCAN) : 0
	const fallbackCount = Math.min(items.length - fallbackStart, FLAT_VIRTUAL_OVERSCAN * 2 + 8)
	const renderedVirtualItems =
		virtualItems.length > 0
			? virtualItems.map((virtualItem) => ({
					key: items[virtualItem.index]?.id ?? String(virtualItem.index),
					item: items[virtualItem.index] ?? null,
					start: virtualItem.start,
				}))
			: Array.from({ length: fallbackCount }, (_, offset) => {
					const index = fallbackStart + offset
					return {
						key: items[index]?.id ?? String(index),
						item: items[index] ?? null,
						start: index * dh.rowH,
					}
				})

	useEffect(() => {
		if (!virtualize || focusedIndex < 0) return
		virtualizer.scrollToIndex(focusedIndex, { align: 'auto' })
	}, [focusedIndex, virtualize, virtualizer])

	if (items.length === 0) {
		return (
			<Box
				style={{
					flex: 1,
					minHeight: 0,
					display: 'flex',
					alignItems: 'center',
					justifyContent: 'center',
					padding: 12,
				}}
			>
				<Text size="sm" c="dimmed">
					{emptyLabel}
				</Text>
			</Box>
		)
	}

	if (!virtualize) {
		return (
			<Box
				style={{
					flex: 1,
					minHeight: 0,
					overflowY: 'auto',
					overflowX: 'hidden',
					paddingRight: 4,
				}}
			>
				<SortableContext
					items={items.map((item) => item.sortableId)}
					strategy={verticalListSortingStrategy}
				>
					<Stack gap={0} align="stretch" role="list" aria-label={listLabel}>
						{items.map((item) => (
							<SortableRow
								key={item.id}
								pid={item.id}
								name={getName(item.id)}
								running={runningSet.has(item.id)}
								enabled={enabledSet.has(item.id)}
								selected={selectedSet.has(item.id)}
								active={activeSet.has(item.id)}
								onSelect={onSelect}
								LinkComp={LinkComp}
								dragDisabled
								focused={focusedId === item.id}
								meta={getMeta(item.id)}
								dh={dh}
								sortableId={item.sortableId}
							/>
						))}
					</Stack>
				</SortableContext>
			</Box>
		)
	}

	return (
		<Box
			ref={scrollRef}
			data-virtual-scroll="true"
			style={{
				flex: 1,
				minHeight: 0,
				overflow: 'auto',
				paddingRight: 4,
			}}
		>
			<SortableContext
				items={items.map((item) => item.sortableId)}
				strategy={verticalListSortingStrategy}
			>
				<Box
					role="list"
					aria-label={listLabel}
					style={{
						height: virtualizer.getTotalSize(),
						position: 'relative',
						width: '100%',
					}}
				>
					{renderedVirtualItems.map((virtualItem) => {
						const item = virtualItem.item
						if (!item) return null
						return (
							<Box
								key={virtualItem.key}
								style={{
									position: 'absolute',
									top: 0,
									left: 0,
									width: '100%',
									transform: `translateY(${virtualItem.start}px)`,
								}}
							>
								<SortableRow
									pid={item.id}
									name={getName(item.id)}
									running={runningSet.has(item.id)}
									enabled={enabledSet.has(item.id)}
									selected={selectedSet.has(item.id)}
									active={activeSet.has(item.id)}
									onSelect={onSelect}
									LinkComp={LinkComp}
									dragDisabled
									focused={focusedId === item.id}
									meta={getMeta(item.id)}
									dh={dh}
									sortableId={item.sortableId}
								/>
							</Box>
						)
					})}
				</Box>
			</SortableContext>
		</Box>
	)
}
