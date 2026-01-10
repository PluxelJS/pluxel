import { Badge, Box, Group, Stack, Text, TextInput } from '@mantine/core'
import { IconSearch } from '@tabler/icons-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAutoFormCtx } from 'valibot-form/web'
import { FloatingToc } from '../../components/FloatingToc'
import { findScrollableParent } from '../utils'

export function FormToc({
	sectionIdPrefix,
	fieldIdPrefix,
	scrollHost,
	scrollHostVersion = 0,
}: {
	sectionIdPrefix: string
	fieldIdPrefix: string
	scrollHost?: HTMLElement | null
	scrollHostVersion: number
}) {
	const { sections } = useAutoFormCtx<any>()
	const [anchors, setAnchors] = useState<{ id: string; label: string; depth: number }[]>([])
	const anchorsRef = useRef<typeof anchors>([])
	const [activeId, setActiveId] = useState<string | null>(null)
	const [showToc, setShowToc] = useState(false)
	const [query, setQuery] = useState('')
	const [tocExpanded, setTocExpanded] = useState(false)
	const tocViewportRef = useRef<HTMLDivElement | null>(null)

	const buildTree = useCallback((list: { id: string; label: string; depth: number }[]) => {
		const roots: { id: string; label: string; depth: number; children: any[] }[] = []
		const stack: { id: string; label: string; depth: number; children: any[] }[] = []
		for (const anchor of list) {
			const node = {
				id: anchor.id,
				label: anchor.label,
				depth: anchor.depth,
				children: [] as any[],
			}
			while (stack.length && stack[stack.length - 1].depth >= node.depth) stack.pop()
			if (stack.length) {
				stack[stack.length - 1].children.push(node)
			} else {
				roots.push(node)
			}
			stack.push(node)
		}
		return roots
	}, [])

	useEffect(() => {
		const host = scrollHost ?? document
		let frame = 0
		let observer: MutationObserver | null = null
		let resizeObserver: ResizeObserver | null = null
		let resizeTarget: HTMLElement | null = null

		const shouldShowToc = () => {
			if (!scrollHost) return false
			return scrollHost.scrollHeight - scrollHost.clientHeight > 24
		}

		const scan = () => {
			frame = 0
			const nodes = Array.from(host.querySelectorAll('[data-config-anchor]')) as HTMLElement[]
			const parsed = nodes
				.map((el) => ({
					id: el.id,
					label: el.getAttribute('data-config-anchor-label') ?? el.id,
					depth: Number(el.getAttribute('data-config-anchor-depth') ?? 1),
				}))
				.filter((item) => {
					if (!item.id) return false
					return (
						item.id.startsWith(sectionIdPrefix) || item.id.startsWith(fieldIdPrefix)
					)
				})
			anchorsRef.current = parsed
			setAnchors(parsed)
			setActiveId((prev) => {
				if (prev && parsed.some((item) => item.id === prev)) return prev
				return parsed[0]?.id ?? null
			})
			setShowToc(parsed.length > 0 && shouldShowToc())
		}

		scan()
		if (scrollHost && typeof MutationObserver !== 'undefined') {
			observer = new MutationObserver(() => {
				if (frame) cancelAnimationFrame(frame)
				frame = requestAnimationFrame(scan)
			})
			observer.observe(scrollHost, {
				childList: true,
				subtree: true,
				attributes: true,
				attributeFilter: ['id', 'data-config-anchor-label'],
			})
		}

		const onResize = () => {
			if (frame) cancelAnimationFrame(frame)
			frame = requestAnimationFrame(() => {
				setShowToc(anchorsRef.current.length > 0 && shouldShowToc())
			})
		}

		if (typeof ResizeObserver !== 'undefined') {
			resizeObserver = new ResizeObserver(onResize)
			resizeTarget =
				scrollHost ?? (document.scrollingElement as HTMLElement | null) ?? document.documentElement
			if (resizeTarget) resizeObserver.observe(resizeTarget)
		} else {
			window.addEventListener('resize', onResize)
		}

		const root = scrollHost ?? window
		const onScroll = () => {
			if (frame) cancelAnimationFrame(frame)
			frame = requestAnimationFrame(() => {
				if (!showToc) return
				const scrollTop = scrollHost ? scrollHost.scrollTop : window.scrollY
				const viewport = scrollHost ? scrollHost.clientHeight : window.innerHeight
				const anchorOffset = 72
				let current: { id: string; score: number } | null = null

				for (const anchor of anchorsRef.current) {
					const el = document.getElementById(anchor.id)
					if (!el) continue
					const container =
						(scrollHost && scrollHost.contains(el) ? scrollHost : null) ??
						el.closest<HTMLElement>('[data-config-scroll-root]') ??
						findScrollableParent(el)
					const pos =
						container &&
						container !== document.scrollingElement &&
						container !== document.documentElement
							? el.getBoundingClientRect().top -
								container.getBoundingClientRect().top +
								container.scrollTop
							: el.getBoundingClientRect().top + window.scrollY
					const delta = Math.abs(pos - scrollTop - anchorOffset)
					const inView = pos >= scrollTop - 20 && pos < scrollTop + viewport - 120
					const score = inView ? delta * 0.5 : delta
					if (!current || score < current.score) {
						current = { id: anchor.id, score }
					}
				}
				if (current?.id) setActiveId(current.id)
			})
		}
		root.addEventListener('scroll', onScroll, { passive: true })
		onScroll()

		return () => {
			root.removeEventListener('scroll', onScroll)
			if (observer) observer.disconnect()
			if (resizeObserver && resizeTarget) resizeObserver.unobserve(resizeTarget)
			if (!resizeObserver) window.removeEventListener('resize', onResize)
			if (frame) cancelAnimationFrame(frame)
		}
	}, [scrollHost, sections.length, sectionIdPrefix, fieldIdPrefix, scrollHostVersion, showToc])

	const items = useMemo(() => buildTree(anchors), [anchors, buildTree])
	const normalizedQuery = query.trim().toLowerCase()
	const filtered = useMemo(() => {
		if (!normalizedQuery) {
			return {
				items,
				matchCount: anchors.length,
			}
		}

		const matches = (label: string) => label.toLowerCase().includes(normalizedQuery)

		let matchCount = 0
		const filterNode = (node: { id: string; label: string; depth: number; children: any[] }) => {
			const nextChildren: any[] = []
			for (const child of node.children) {
				const childNode = filterNode(child)
				if (childNode) nextChildren.push(childNode)
			}

			const selfMatch = matches(node.label)
			if (selfMatch) matchCount += 1

			if (selfMatch || nextChildren.length > 0) {
				return { ...node, children: nextChildren }
			}
			return null
		}

		const filteredItems = items
			.map((node) => filterNode(node))
			.filter((node): node is { id: string; label: string; depth: number; children: any[] } => Boolean(node))

		return {
			items: filteredItems,
			matchCount,
		}
	}, [anchors.length, items, normalizedQuery])

	const scrollToSection = useCallback(
		(id: string) => {
			if (!id) return
			const target = document.getElementById(id)
			if (!target) return
			const scrollMarginTop =
				Number.parseFloat(getComputedStyle(target).scrollMarginTop || '0') || 0
			const container =
				(scrollHost && scrollHost.contains(target) ? scrollHost : null) ??
				target.closest<HTMLElement>('[data-config-scroll-root]') ??
				findScrollableParent(target)

			if (
				container &&
				container !== document.scrollingElement &&
				container !== document.documentElement
			) {
				const targetBox = target.getBoundingClientRect()
				const hostBox = container.getBoundingClientRect()
				const top = targetBox.top - hostBox.top + container.scrollTop - scrollMarginTop
				container.scrollTo({ top, behavior: 'smooth' })
			} else {
				const top = target.getBoundingClientRect().top + window.scrollY - scrollMarginTop
				window.scrollTo({ top, behavior: 'smooth' })
			}
		},
		[scrollHost],
	)

	useEffect(() => {
		if (!tocExpanded) return
		const viewport = tocViewportRef.current
		if (!viewport) return
		const active = viewport.querySelector('[data-toc-active="true"]') as HTMLElement | null
		if (!active) return
		const activeBox = active.getBoundingClientRect()
		const viewportBox = viewport.getBoundingClientRect()
		const padding = 16
		if (activeBox.top < viewportBox.top + padding || activeBox.bottom > viewportBox.bottom - padding) {
			active.scrollIntoView({ block: 'center' })
		}
	}, [tocExpanded, activeId, normalizedQuery])

	if (!items.length || !showToc) return null

	const renderNode = (node: { id: string; label: string; children: any[] }, depth = 0) => {
		const isActive = node.id === activeId
		return (
			<Box
				key={node.id}
				onClick={(e) => {
					e.stopPropagation()
					scrollToSection(node.id)
				}}
				role="button"
				tabIndex={0}
				data-toc-active={isActive ? 'true' : undefined}
				onKeyDown={(e) => {
					if (e.key === 'Enter' || e.key === ' ') {
						e.preventDefault()
						e.stopPropagation()
						scrollToSection(node.id)
					}
				}}
				style={{
					borderRadius: 10,
					padding: '8px 10px',
					cursor: 'pointer',
					border: `1px solid ${
						isActive ? 'var(--mantine-color-blue-outline)' : 'var(--mantine-color-default-border)'
					}`,
					backgroundColor: isActive ? 'var(--mantine-color-blue-light)' : 'transparent',
					boxShadow: isActive
						? 'inset 3px 0 0 var(--mantine-color-blue-filled), var(--mantine-shadow-sm)'
						: 'none',
					marginLeft: depth ? 8 : 0,
					position: 'relative',
				}}
			>
				<Group justify="space-between" align="center" gap={6} style={{ minWidth: 0 }}>
					<Group gap={8} align="center" style={{ minWidth: 0 }}>
						<Box
							style={{
								width: 8,
								height: 8,
								borderRadius: 999,
								background: isActive
									? 'var(--mantine-color-blue-filled)'
									: 'var(--mantine-color-gray-5)',
								flexShrink: 0,
								boxShadow: isActive ? '0 0 0 3px var(--mantine-color-blue-light)' : 'none',
							}}
						/>
						<Text size="sm" fw={isActive ? 700 : 600} style={{ flex: 1, minWidth: 0 }} lineClamp={1}>
							{node.label}
						</Text>
					</Group>
					{node.children.length ? (
						<Badge variant="light" size="xs" color="gray">
							{node.children.length}
						</Badge>
					) : null}
				</Group>
				{node.children.length ? (
					<Stack gap={6} mt={6}>
						{node.children.map((child) => renderNode(child, depth + 1))}
					</Stack>
				) : null}
			</Box>
		)
	}

	const totalCount = anchors.length
	const shownItems = normalizedQuery ? filtered.items : items
	const shownMatches = normalizedQuery ? filtered.matchCount : totalCount

	return (
		<FloatingToc
			title="配置导航"
			hint="悬停展开，搜索或点击跳转到对应配置项。"
			meta={
				<Badge size="xs" variant="light" color="blue">
					{normalizedQuery ? `${shownMatches}/${totalCount}` : totalCount}
				</Badge>
			}
			controls={
				<TextInput
					size="xs"
					placeholder="搜索配置项…"
					value={query}
					onChange={(event) => setQuery(event.currentTarget.value)}
					leftSection={<IconSearch size={14} />}
				/>
			}
			onExpandedChange={setTocExpanded}
			viewportRef={(node) => {
				tocViewportRef.current = node
			}}
		>
			{shownItems.length ? (
				<Stack gap="xs">{shownItems.map((item) => renderNode(item))}</Stack>
			) : (
				<Text size="xs" c="dimmed">
					暂无匹配项
				</Text>
			)}
		</FloatingToc>
	)
}
