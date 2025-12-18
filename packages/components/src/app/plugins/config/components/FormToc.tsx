import {
	ActionIcon,
	Affix,
	Badge,
	Box,
	Group,
	Paper,
	ScrollArea,
	Stack,
	Text,
} from '@mantine/core'
import {
	IconChevronLeft,
	IconChevronRight,
	IconCircleFilled,
	IconListDetails,
} from '@tabler/icons-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAutoFormCtx } from 'valibot-form/web'
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
	const [expanded, setExpanded] = useState(false)
	const peekWidth = 72

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

		const scan = () => {
			frame = 0
			const nodes = Array.from(host.querySelectorAll('[data-config-anchor]')) as HTMLElement[]
			const parsed = nodes.map((el) => ({
				id: el.id,
				label: el.getAttribute('data-config-anchor-label') ?? el.id,
				depth: Number(el.getAttribute('data-config-anchor-depth') ?? 1),
			}))
			anchorsRef.current = parsed
			setAnchors(parsed)
			setActiveId((prev) => prev ?? parsed[0]?.id ?? null)
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

		const root = scrollHost ?? window
		const onScroll = () => {
			if (frame) cancelAnimationFrame(frame)
			frame = requestAnimationFrame(() => {
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
			if (frame) cancelAnimationFrame(frame)
		}
	}, [scrollHost, sections.length, sectionIdPrefix, fieldIdPrefix, scrollHostVersion])

	const items = useMemo(() => buildTree(anchors), [anchors, buildTree])

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

	if (!items.length) return null

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
				onKeyDown={(e) => {
					if (e.key === 'Enter' || e.key === ' ') {
						e.preventDefault()
						e.stopPropagation()
						scrollToSection(node.id)
					}
				}}
				style={{
					borderRadius: 12,
					padding: '10px 12px',
					cursor: 'pointer',
					border: `1px solid ${isActive ? 'var(--mantine-color-blue-outline)' : 'var(--mantine-color-default-border)'}`,
					backgroundColor: isActive
						? 'var(--mantine-color-blue-light)'
						: 'var(--mantine-color-body)',
					boxShadow: isActive ? 'var(--mantine-shadow-sm)' : 'none',
					marginLeft: depth ? 10 : 0,
					position: 'relative',
				}}
			>
				<Group justify="space-between" align="center" gap={6} style={{ minWidth: 0 }}>
					<Group gap={6} align="center" style={{ minWidth: 0 }}>
						<IconCircleFilled size={12} color="var(--mantine-color-blue-filled)" />
						<Text
							size="sm"
							fw={isActive ? 700 : 600}
							style={{ flex: 1, minWidth: 0 }}
							lineClamp={1}
						>
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
					<Stack gap={6} mt={8}>
						{node.children.map((child) => renderNode(child, depth + 1))}
					</Stack>
				) : null}
			</Box>
		)
	}

	return (
		<Affix position={{ top: 86, right: 16 }} zIndex={950} withinPortal>
			<Box
				onMouseEnter={() => setExpanded(true)}
				onMouseLeave={() => setExpanded(false)}
				onFocus={() => setExpanded(true)}
				onBlur={() => setExpanded(false)}
				style={{ width: 320, maxWidth: '80vw' }}
			>
				<Paper
					withBorder
					shadow="md"
					p="sm"
					radius="lg"
					style={{
						transition: 'transform 160ms ease, box-shadow 160ms ease',
						transform: expanded
							? 'translateX(0)'
							: `translateX(calc(100% - ${peekWidth}px))`,
						maxHeight: '72vh',
						overflow: 'hidden',
						backgroundColor: 'var(--mantine-color-body)',
						border: '1px solid var(--mantine-color-default-border)',
						boxShadow: expanded ? 'var(--mantine-shadow-lg)' : 'var(--mantine-shadow-sm)',
					}}
				>
					<Stack gap="xs" style={{ height: '100%' }}>
						<Group justify="space-between" align="center" gap="xs">
							<Group gap={8} wrap="nowrap" style={{ minWidth: 0 }}>
								<IconListDetails size={18} color="var(--mantine-color-blue-filled)" />
								<Text
									size="sm"
									fw={700}
									style={{
										whiteSpace: 'nowrap',
										overflow: 'hidden',
										textOverflow: 'ellipsis',
										maxWidth: peekWidth - 12,
									}}
								>
									配置导航
								</Text>
								<Badge size="xs" variant="light" color="blue">
									TOC
								</Badge>
							</Group>
							<ActionIcon
								variant="subtle"
								aria-label={expanded ? '收起目录' : '展开目录'}
								onClick={() => setExpanded((v) => !v)}
							>
								{expanded ? <IconChevronRight size={16} /> : <IconChevronLeft size={16} />}
							</ActionIcon>
						</Group>
						<Text size="xs" c="dimmed">
							悬停展开，点击跳转到对应 section/字段。
						</Text>
						<ScrollArea style={{ maxHeight: '62vh' }} type="auto" scrollbarSize={8}>
							<Stack gap="xs" pr={4}>
								{items.map((item) => renderNode(item))}
							</Stack>
						</ScrollArea>
					</Stack>
				</Paper>
			</Box>
		</Affix>
	)
}

