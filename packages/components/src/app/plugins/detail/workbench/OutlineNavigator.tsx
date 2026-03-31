import { Badge, Box, Group, ScrollArea, Stack, Text, TextInput } from '@mantine/core'
import { IconSearch } from '@tabler/icons-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
	buildOutlineTree,
	filterOutlineTree,
	type OutlineAnchor,
	type OutlineNode,
} from './outline'

type OutlineNavigatorState = {
	query: string
	hasQuery: boolean
	totalCount: number
	shownCount: number
}

export function OutlineNavigator({
	anchors,
	activeId,
	onSelect,
	placeholder,
	emptyLabel,
	header,
	showBranchCount = false,
	maxHeight = 360,
}: {
	anchors: OutlineAnchor[]
	activeId: string | null
	onSelect: (id: string) => void
	placeholder: string
	emptyLabel: string
	header?: (state: OutlineNavigatorState) => ReactNode
	showBranchCount?: boolean
	maxHeight?: number
}) {
	const [query, setQuery] = useState('')
	const viewportRef = useRef<HTMLDivElement | null>(null)
	const items = useMemo(() => buildOutlineTree(anchors), [anchors])
	const normalizedQuery = query.trim().toLowerCase()
	const filtered = useMemo(
		() => filterOutlineTree(items, normalizedQuery),
		[items, normalizedQuery],
	)
	const shownItems = normalizedQuery ? filtered.items : items
	const totalCount = anchors.length
	const shownCount = normalizedQuery ? filtered.matchCount : totalCount

	useEffect(() => {
		const viewport = viewportRef.current
		if (!viewport) return
		const active = viewport.querySelector('[data-toc-active="true"]') as HTMLElement | null
		if (!active) return
		const activeBox = active.getBoundingClientRect()
		const viewportBox = viewport.getBoundingClientRect()
		const padding = 16
		if (
			activeBox.top < viewportBox.top + padding ||
			activeBox.bottom > viewportBox.bottom - padding
		) {
			active.scrollIntoView?.({ block: 'center' })
		}
	}, [activeId, normalizedQuery])

	return (
		<Stack gap="xs" className="plx-pluginWorkbench__outline">
			{header
				? header({
						query,
						hasQuery: normalizedQuery.length > 0,
						totalCount,
						shownCount,
					})
				: null}
			<TextInput
				size="xs"
				placeholder={placeholder}
				value={query}
				onChange={(event) => setQuery(event.currentTarget.value)}
				leftSection={<IconSearch size={14} />}
				classNames={{ root: 'plx-pluginWorkbench__outlineSearch' }}
			/>
			<ScrollArea
				type="auto"
				scrollbarSize={8}
				viewportRef={(node) => {
					viewportRef.current = node
				}}
				className="plx-pluginWorkbench__outlineScroll"
				style={{ maxHeight }}
			>
				{shownItems.length ? (
					<Stack gap="xs" className="plx-pluginWorkbench__outlineList">
						{shownItems.map((item) => (
							<OutlineNodeButton
								key={item.id}
								node={item}
								activeId={activeId}
								onSelect={onSelect}
								showBranchCount={showBranchCount}
							/>
						))}
					</Stack>
				) : (
					<Text size="xs" c="dimmed" className="plx-pluginWorkbench__outlineEmpty">
						{emptyLabel}
					</Text>
				)}
			</ScrollArea>
		</Stack>
	)
}

function OutlineNodeButton({
	node,
	activeId,
	onSelect,
	showBranchCount,
	depth = 0,
}: {
	node: OutlineNode
	activeId: string | null
	onSelect: (id: string) => void
	showBranchCount: boolean
	depth?: number
}) {
	const isActive = node.id === activeId

	return (
		<Box
			className="plx-pluginWorkbench__outlineItem"
			style={depth ? { paddingInlineStart: depth * 12 } : undefined}
		>
			<Box
				component="button"
				type="button"
				onClick={() => onSelect(node.id)}
				className="plx-pluginWorkbench__outlineNode"
				data-active={isActive ? 'true' : 'false'}
				data-toc-active={isActive ? 'true' : undefined}
			>
				<Group
					justify="space-between"
					align="center"
					gap={6}
					className="plx-pluginWorkbench__outlineRow"
				>
					<Group gap={8} align="center" className="plx-pluginWorkbench__outlineLabelGroup">
						<Box
							className="plx-pluginWorkbench__outlineDot"
							data-active={isActive ? 'true' : 'false'}
						/>
						<Text
							size="sm"
							fw={isActive ? 700 : 600}
							className="plx-pluginWorkbench__outlineLabel"
							lineClamp={1}
						>
							{node.label}
						</Text>
					</Group>
					{showBranchCount && node.children.length ? (
						<Badge variant="light" size="xs" color="gray">
							{node.children.length}
						</Badge>
					) : null}
				</Group>
			</Box>
			{node.children.length ? (
				<Stack gap={6} mt={6} className="plx-pluginWorkbench__outlineBranch">
					{node.children.map((child) => (
						<OutlineNodeButton
							key={child.id}
							node={child}
							activeId={activeId}
							onSelect={onSelect}
							showBranchCount={showBranchCount}
							depth={depth + 1}
						/>
					))}
				</Stack>
			) : null}
		</Box>
	)
}
