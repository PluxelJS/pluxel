import { Badge, Box, Stack, Text, TextInput, TypographyStylesProvider } from '@mantine/core'
import { IconSearch } from '@tabler/icons-react'
import { MarkdownExit } from 'markdown-exit'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode, RefObject } from 'react'
import type { BuiltinDocBlock, BuiltinDocContent, BuiltinDocExtensionDef, BuiltinDocPart } from '../types'
import { useExtensionContext } from '../types'
import { FloatingToc } from '../../app/plugins/components/FloatingToc'
import { findScrollableParent, toDomSlug } from '../../app/plugins/config/utils'
import { BuiltinInfoCard } from './InfoCard'
import { BuiltinRpcAutoForm } from './RpcAutoForm'

type DocAnchor = { id: string; label: string; depth: number }

type CompiledItem =
	| { kind: 'html'; key: string; html: string }
	| { kind: 'block'; key: string; id: string; title: string; block: BuiltinDocBlock }

function extractInlineText(token: any): string {
	if (!token || typeof token !== 'object') return ''
	if (typeof token.content === 'string') return token.content
	const children = Array.isArray(token.children) ? token.children : []
	return children
		.map((child: any) => {
			if (typeof child?.content === 'string') return child.content
			return ''
		})
		.join('')
}

function compileDoc(input: {
	content: BuiltinDocContent
	docPrefix: string
}): { items: CompiledItem[]; anchors: DocAnchor[] } {
	const { content, docPrefix } = input
	const engine = new MarkdownExit({ html: false, linkify: true })
	const env: Record<string, unknown> = {}

	const seen = new Map<string, number>()
	const anchors: DocAnchor[] = []
	const items: CompiledItem[] = []

	let mdIndex = 0
	let blockIndex = 0

	const parts: BuiltinDocPart[] = Array.isArray(content) ? content : []
	for (const part of parts) {
		if (!part || typeof part !== 'object') continue

		if (part.kind === 'block') {
			if (!part.block || typeof part.block !== 'object') continue
			const label = String((part as any).title ?? '').trim()
			if (!label) continue
			const base = `${docPrefix}${toDomSlug(label)}`
			const count = (seen.get(base) ?? 0) + 1
			seen.set(base, count)
			const id = count === 1 ? base : `${base}-${count}`
			anchors.push({ id, label, depth: 2 })
			blockIndex += 1
			items.push({ kind: 'block', key: `block-${blockIndex}`, id, title: label, block: part.block })
			continue
		}

		if (part.kind !== 'md') continue
		const text = typeof part.text === 'string' ? part.text : ''
		if (!text) continue

		const tokens = engine.parse(text, env)
		for (let i = 0; i < tokens.length; i++) {
			const token = tokens[i]
			if (!token || token.type !== 'heading_open') continue
			const depth = Number.parseInt(String(token.tag ?? '').slice(1), 10)
			const inline = tokens[i + 1]
			const label = extractInlineText(inline).trim()
			if (!label) continue
			const base = `${docPrefix}${toDomSlug(label)}`
			const count = (seen.get(base) ?? 0) + 1
			seen.set(base, count)
			const id = count === 1 ? base : `${base}-${count}`
			token.attrSet('id', id)
			token.attrSet('style', 'scroll-margin-top: 72px;')
			anchors.push({ id, label, depth: Number.isFinite(depth) ? depth : 1 })
		}

		mdIndex += 1
		const html = engine.renderer.render(tokens, engine.options, env)
		items.push({ kind: 'html', key: `md-${mdIndex}`, html })
	}

	return { items, anchors }
}

const DocBody = memo(function DocBody({
	items,
	contentRef,
	renderBlock,
}: {
	items: CompiledItem[]
	contentRef: RefObject<HTMLDivElement>
	renderBlock: (title: string, block: BuiltinDocBlock) => ReactNode
}) {
	return (
		<Box
			ref={contentRef}
			style={{
				padding: 0,
				borderRadius: 0,
				background: 'transparent',
				border: 'none',
			}}
		>
			<TypographyStylesProvider>
					{items.map((item) => {
						if (item.kind === 'block')
							return (
								<Box key={item.key} my="sm">
									<Box component="h2" id={item.id} style={{ scrollMarginTop: 72 }}>
										{item.title}
									</Box>
									{renderBlock(item.title, item.block)}
								</Box>
							)
						return <Box key={item.key} dangerouslySetInnerHTML={{ __html: item.html }} />
					})}
			</TypographyStylesProvider>
		</Box>
	)
})

export function BuiltinDoc({ def }: { def: BuiltinDocExtensionDef }) {
	useExtensionContext()

	const contentRef = useRef<HTMLDivElement | null>(null)
	const tocViewportRef = useRef<HTMLDivElement | null>(null)
	const [activeId, setActiveId] = useState<string | null>(null)
	const [tocExpanded, setTocExpanded] = useState(false)
	const [query, setQuery] = useState('')
	const [scrollHost, setScrollHost] = useState<HTMLElement | null>(null)

	const docPrefix = useMemo(
		() => `doc-${toDomSlug(def.pluginName)}-${toDomSlug(def.id)}-`,
		[def.id, def.pluginName],
	)

	const pluginName = def.pluginName
	const renderBlock = useCallback(
		(title: string, block: BuiltinDocBlock) => {
			if (block.kind === 'infoCard') return <BuiltinInfoCard pluginName={pluginName} block={block} />
			if (block.kind === 'rpcAutoForm')
				return <BuiltinRpcAutoForm pluginName={pluginName} title={title} block={block} />
			return null
		},
		[pluginName],
	)

	const compiled = useMemo(
		() => compileDoc({ content: def.content, docPrefix }),
		[def.content, docPrefix],
	)

	const headingAnchors = compiled.anchors
	const hasToc = headingAnchors.length > 1

	const hasHeader = Boolean(def.title || def.description)
	if (compiled.items.length === 0 && !hasHeader) return null

	const buildTree = useCallback((list: DocAnchor[]) => {
		const roots: Array<{ id: string; label: string; depth: number; children: any[] }> = []
		const stack: Array<{ id: string; label: string; depth: number; children: any[] }> = []
		for (const anchor of list) {
			const node = { id: anchor.id, label: anchor.label, depth: anchor.depth, children: [] as any[] }
			while (stack.length && stack[stack.length - 1].depth >= node.depth) stack.pop()
			if (stack.length) stack[stack.length - 1].children.push(node)
			else roots.push(node)
			stack.push(node)
		}
		return roots
	}, [])

	const resolveScrollContainer = useCallback(
		(target: HTMLElement | null) => {
			if (!target) return null
			const candidate =
				(scrollHost && scrollHost.contains(target) ? scrollHost : null) ??
				target.closest<HTMLElement>('[data-scroll-area-viewport]') ??
				findScrollableParent(target)
			if (!candidate) return null
			if (candidate === document.scrollingElement || candidate === document.documentElement) return null
			return candidate
		},
		[scrollHost],
	)

	const updateActive = useCallback(() => {
		if (!hasToc) return
		const container = resolveScrollContainer(contentRef.current)
		const scrollTop = container ? container.scrollTop : window.scrollY
		const viewport = container ? container.clientHeight : window.innerHeight
		const containerBox = container ? container.getBoundingClientRect() : null
		const anchorOffset = 72
		let current: { id: string; score: number } | null = null

		for (const anchor of headingAnchors) {
			const el = document.getElementById(anchor.id)
			if (!el) continue
			const pos = container
				? el.getBoundingClientRect().top - (containerBox?.top ?? 0) + container.scrollTop
				: el.getBoundingClientRect().top + window.scrollY
			const delta = Math.abs(pos - scrollTop - anchorOffset)
			const inView = pos >= scrollTop - 20 && pos < scrollTop + viewport - 120
			const score = inView ? delta * 0.5 : delta
			if (!current || score < current.score) current = { id: anchor.id, score }
		}
		if (current?.id) setActiveId((prev) => (prev === current.id ? prev : current.id))
	}, [hasToc, headingAnchors, resolveScrollContainer])

	useEffect(() => {
		setActiveId((prev) => {
			if (prev && headingAnchors.some((item) => item.id === prev)) return prev
			return headingAnchors[0]?.id ?? null
		})
	}, [headingAnchors])

	useEffect(() => {
		const root = contentRef.current
		if (!root) {
			setScrollHost(null)
			return
		}

		const firstAnchorEl = headingAnchors[0]?.id ? document.getElementById(headingAnchors[0].id) : null
		const base = firstAnchorEl ?? root
		const host =
			base.closest<HTMLElement>('[data-scroll-area-viewport]') ?? findScrollableParent(base)
		if (host === document.scrollingElement || host === document.documentElement) setScrollHost(null)
		else setScrollHost(host)
	}, [headingAnchors, compiled.items.length])

	useEffect((): void | (() => void) => {
		const root = contentRef.current
		if (!root) return undefined
		const fallbackHost = findScrollableParent(root)
		const host =
			scrollHost ??
			(fallbackHost === document.scrollingElement || fallbackHost === document.documentElement ? null : fallbackHost)
		const primary = host ?? window

		let frame = 0
		const onScroll = () => {
			if (frame) cancelAnimationFrame(frame)
			frame = requestAnimationFrame(updateActive)
		}
		primary.addEventListener('scroll', onScroll, { passive: true })
		if (primary !== window) window.addEventListener('scroll', onScroll, { passive: true })
		document.addEventListener('scroll', onScroll, { passive: true, capture: true })
		updateActive()

		let resizeObserver: ResizeObserver | null = null
		if (typeof ResizeObserver !== 'undefined' && primary !== window) {
			resizeObserver = new ResizeObserver(() => updateActive())
			resizeObserver.observe(primary as HTMLElement)
		}

		return () => {
			primary.removeEventListener('scroll', onScroll)
			if (primary !== window) window.removeEventListener('scroll', onScroll)
			document.removeEventListener('scroll', onScroll, { capture: true })
			if (frame) cancelAnimationFrame(frame)
			if (resizeObserver) resizeObserver.disconnect()
		}
	}, [scrollHost, updateActive])

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
	}, [tocExpanded, activeId, query])

	const scrollToSection = useCallback(
		(id: string) => {
			if (!id) return
			const target = document.getElementById(id)
			if (!target) return
			const scrollMarginTop = Number.parseFloat(getComputedStyle(target).scrollMarginTop || '0') || 0
			const container = resolveScrollContainer(target)
			if (container) {
				const targetBox = target.getBoundingClientRect()
				const hostBox = container.getBoundingClientRect()
				const top = targetBox.top - hostBox.top + container.scrollTop - scrollMarginTop
				container.scrollTo({ top, behavior: 'smooth' })
				return
			}
			const top = target.getBoundingClientRect().top + window.scrollY - scrollMarginTop
			window.scrollTo({ top, behavior: 'smooth' })
		},
		[resolveScrollContainer],
	)

	const tocItems = useMemo(() => buildTree(headingAnchors), [headingAnchors, buildTree])
	const normalizedQuery = query.trim().toLowerCase()
	const filtered = useMemo(() => {
		if (!normalizedQuery) return { items: tocItems, matchCount: headingAnchors.length }
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
			if (selfMatch || nextChildren.length > 0) return { ...node, children: nextChildren }
			return null
		}
		return {
			items: tocItems
				.map((node) => filterNode(node))
				.filter(
					(node): node is { id: string; label: string; depth: number; children: any[] } => Boolean(node),
				),
			matchCount,
		}
	}, [headingAnchors.length, normalizedQuery, tocItems])

	return (
		<Box>
			<Stack gap="xs">
				{def.title || def.description ? (
					<Stack gap={4}>
						{def.title ? (
							<Text size="sm" fw={650} style={{ lineHeight: 1.25 }}>
								{def.title}
							</Text>
						) : null}
						{def.description ? (
							<Text size="xs" c="dimmed" style={{ lineHeight: 1.4 }}>
								{def.description}
							</Text>
						) : null}
					</Stack>
				) : null}

				{compiled.items.length ? (
					<DocBody items={compiled.items} contentRef={contentRef} renderBlock={renderBlock} />
				) : null}
			</Stack>

			{hasToc && compiled.items.length && tocItems.length ? (
				<FloatingToc
					title="文档导航"
					hint="悬停展开，搜索或点击跳转到对应章节。"
					meta={
						<Badge size="xs" variant="light" color="blue">
							{normalizedQuery ? `${filtered.matchCount}/${headingAnchors.length}` : headingAnchors.length}
						</Badge>
					}
					controls={
						<TextInput
							size="xs"
							placeholder="搜索章节…"
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
					{(normalizedQuery ? filtered.items : tocItems).length ? (
						<Stack gap="xs">
							{(normalizedQuery ? filtered.items : tocItems).map((node) => {
								const renderNode = (item: { id: string; label: string; children: any[] }, depth = 0) => {
									const isActive = item.id === activeId
									return (
										<Box
											key={item.id}
											onClick={(e) => {
												e.stopPropagation()
												scrollToSection(item.id)
											}}
											role="button"
											tabIndex={0}
											data-toc-active={isActive ? 'true' : undefined}
											onKeyDown={(e) => {
												if (e.key === 'Enter' || e.key === ' ') {
													e.preventDefault()
													e.stopPropagation()
													scrollToSection(item.id)
												}
											}}
											style={{
												borderRadius: 10,
												padding: '8px 10px',
												cursor: 'pointer',
												border: `1px solid ${
													isActive
														? 'var(--mantine-color-blue-outline)'
														: 'var(--mantine-color-default-border)'
												}`,
												backgroundColor: isActive ? 'var(--mantine-color-blue-light)' : 'transparent',
												boxShadow: isActive
													? 'inset 3px 0 0 var(--mantine-color-blue-filled), var(--mantine-shadow-sm)'
													: 'none',
												marginLeft: depth ? 8 : 0,
												position: 'relative',
												transition:
													'background-color 140ms ease, border-color 140ms ease, box-shadow 140ms ease',
											}}
										>
											<Box
												style={{
													display: 'flex',
													alignItems: 'center',
													gap: 8,
													minWidth: 0,
												}}
											>
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
												<Text
													size="sm"
													fw={isActive ? 700 : 600}
													style={{ flex: 1, minWidth: 0, userSelect: 'none' }}
													lineClamp={1}
												>
													{item.label}
												</Text>
											</Box>
											{item.children?.length ? (
												<Stack gap={6} mt={6}>
													{item.children.map((child: any) => renderNode(child, depth + 1))}
												</Stack>
											) : null}
										</Box>
									)
								}
								return renderNode(node, 0)
							})}
						</Stack>
					) : (
						<Text size="xs" c="dimmed">
							未找到匹配章节
						</Text>
					)}
				</FloatingToc>
			) : null}
		</Box>
	)
}
