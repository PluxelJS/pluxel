import { Badge, Box, Group, Stack, Text, TextInput, TypographyStylesProvider } from '@mantine/core'
import { IconSearch } from '@tabler/icons-react'
import { createElement, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode, RefObject } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkDirective from 'remark-directive'
import remarkGfm from 'remark-gfm'
import { visit } from 'unist-util-visit'
import type {
	BuiltinDocBlock,
	BuiltinDocExtensionDef,
} from '../types'
import { useExtensionContext } from '../types'
import { FloatingToc } from '../../app/plugins/components/FloatingToc'
import { findScrollableParent, toDomSlug } from '../../app/plugins/config/utils'
import { BuiltinInfoCard } from './InfoCard'
import { BuiltinRpcAutoForm } from './RpcAutoForm'

type DirectiveNode = {
	type?: string
	name?: string
	label?: string
	attributes?: Record<string, unknown>
	children?: unknown[]
	data?: Record<string, unknown>
}

type DocAnchor = { id: string; label: string; depth: number }

type DocMarkdownProps = {
	content: string
	contentRef: RefObject<HTMLDivElement>
	headingAnchors: DocAnchor[]
	blockMap: Record<string, BuiltinDocBlock>
	renderBlock: (block: BuiltinDocBlock) => ReactNode
}

function collectText(node: any): string {
	if (!node) return ''
	if (Array.isArray(node)) return node.map(collectText).join('')
	if (typeof node.value === 'string') return node.value
	if (Array.isArray(node.children)) return node.children.map(collectText).join('')
	return ''
}

function readDirectiveLabel(directive: DirectiveNode): string {
	if (!directive || typeof directive !== 'object') return ''
	if (directive.type === 'containerDirective') {
		const labelNode = Array.isArray(directive.children)
			? directive.children.find((child: any) => Boolean(child?.data?.directiveLabel))
			: null
		if (labelNode) return collectText(labelNode)
	}
	return collectText(directive.children)
}

function parseMarkdownHeadings(content: string, docPrefix: string): DocAnchor[] {
	const anchors: DocAnchor[] = []
	const seen = new Map<string, number>()
	let inFence = false
	const lines = content.split(/\r?\n/)
	for (const raw of lines) {
		const line = raw.trimEnd()
		const fenceMatch = line.match(/^\s*(```|~~~)/)
		if (fenceMatch) {
			inFence = !inFence
			continue
		}
		if (inFence) continue
		const match = line.match(/^\s{0,3}(#{1,6})\s+(.+)$/)
		if (!match) continue
		const depth = match[1].length
		const label = match[2].replace(/\s+#+\s*$/, '').trim()
		if (!label) continue
		const base = `${docPrefix}${toDomSlug(label)}`
		const count = (seen.get(base) ?? 0) + 1
		seen.set(base, count)
		const id = count === 1 ? base : `${base}-${count}`
		anchors.push({ id, label, depth })
	}
	return anchors
}

function remarkDocBlocks() {
	return (tree: any) => {
		visit(tree, (node: any) => {
			const directive = node as DirectiveNode
			if (!directive || typeof directive !== 'object') return
			if (directive.type !== 'leafDirective' && directive.type !== 'containerDirective') return
			if (directive.name !== 'block') return

			const attrs = directive.attributes ?? {}
			const label = readDirectiveLabel(directive).trim()
			const attrId = typeof attrs.id === 'string' ? attrs.id.trim() : ''
			const id = attrId || label

			const data = directive.data ?? (directive.data = {})
			data.hName = 'block'
			data.hProperties = id ? { id } : {}

			if (directive.type === 'containerDirective') directive.children = []
		})
	}
}

const DocMarkdown = memo(function DocMarkdown({
	content,
	contentRef,
	headingAnchors,
	blockMap,
	renderBlock,
}: DocMarkdownProps) {
	const headingIndexRef = useRef(0)
	headingIndexRef.current = 0

	const BlockRenderer = useCallback(
		({ node }: { node?: any }) => {
			const rawId = node?.properties?.id
			const id = typeof rawId === 'string' ? rawId.trim() : ''
			if (!id || !blockMap[id]) {
				if (process.env.NODE_ENV === 'production') return null
				return (
					<Box
						my="sm"
						p="xs"
						style={{
							borderRadius: 8,
							border: '1px dashed rgba(255, 90, 80, 0.45)',
							background: 'rgba(255, 90, 80, 0.06)',
						}}
					>
						<Text size="xs" c="red">
							{`Missing doc block: ${id || '(no id)'}`}
						</Text>
					</Box>
				)
			}

			return <Box my="sm">{renderBlock(blockMap[id])}</Box>
		},
		[blockMap, renderBlock],
	)

	const makeHeading = useCallback(
		(level: number) => {
			return ({ node: _node, ...rest }: any) => {
				const anchor = headingAnchors[headingIndexRef.current]
				headingIndexRef.current += 1
				const props = anchor ? { ...rest, id: anchor.id } : rest
				return createElement(`h${level}`, props, rest.children)
			}
		},
		[headingAnchors],
	)

	const components = useMemo(
		() =>
			({
				block: BlockRenderer,
				h1: makeHeading(1),
				h2: makeHeading(2),
				h3: makeHeading(3),
				h4: makeHeading(4),
				h5: makeHeading(5),
				h6: makeHeading(6),
			}) as any,
		[BlockRenderer, makeHeading],
	)

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
				<ReactMarkdown remarkPlugins={[remarkGfm, remarkDirective, remarkDocBlocks]} components={components}>
					{content}
				</ReactMarkdown>
			</TypographyStylesProvider>
		</Box>
	)
})

export function BuiltinDoc({
	def,
}: {
	def: BuiltinDocExtensionDef
}) {
	useExtensionContext()
	const content = typeof def.content === 'string' ? def.content.trim() : ''
	const blocks = def.blocks && typeof def.blocks === 'object' ? def.blocks : {}
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

	const headingAnchors = useMemo(
		() => (content ? parseMarkdownHeadings(content, docPrefix) : []),
		[content, docPrefix],
	)

	const hasToc = headingAnchors.length > 1

	const blockMap = useMemo(() => {
		const out: Record<string, BuiltinDocBlock> = {}
		for (const [key, block] of Object.entries(blocks)) {
			if (!block || typeof block !== 'object') continue
			const typed = block as BuiltinDocBlock
			if (typed.kind !== 'infoCard' && typed.kind !== 'rpcAutoForm') continue
			out[key] = typed
		}
		return out
	}, [blocks])

	const orderedBlockIds =
		Array.isArray(def.blockOrder) && def.blockOrder.length > 0
			? def.blockOrder
			: Object.keys(blockMap)

	const blockEntries = orderedBlockIds
		.map((id) => ({ id, block: blockMap[id] }))
		.filter((entry): entry is { id: string; block: BuiltinDocBlock } => Boolean(entry.block))

	const pluginName = def.pluginName
	const renderBlock = useCallback(
		(block: BuiltinDocBlock) => {
			if (block.kind === 'infoCard') {
				return <BuiltinInfoCard pluginName={pluginName} block={block} />
			}
			if (block.kind === 'rpcAutoForm') {
				return <BuiltinRpcAutoForm pluginName={pluginName} block={block} />
			}
			return null
		},
		[pluginName],
	)

	const hasHeader = Boolean(def.title || def.description)

	if (!content && blockEntries.length === 0 && !hasHeader) return null

	if (!content && !hasHeader) {
		return (
			<Stack gap={6}>
				{blockEntries.map((entry) => (
					<Box key={entry.id}>{renderBlock(entry.block)}</Box>
				))}
			</Stack>
		)
	}

	const buildTree = useCallback((list: DocAnchor[]) => {
		const roots: Array<{ id: string; label: string; depth: number; children: any[] }> = []
		const stack: Array<{ id: string; label: string; depth: number; children: any[] }> = []
		for (const anchor of list) {
			const node = { id: anchor.id, label: anchor.label, depth: anchor.depth, children: [] as any[] }
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
		if (current?.id) {
			setActiveId((prev) => (prev === current.id ? prev : current.id))
		}
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
		const firstAnchor = headingAnchors[0]?.id
			? document.getElementById(headingAnchors[0].id)
			: null
		const base = firstAnchor ?? root
		const host =
			base.closest<HTMLElement>('[data-scroll-area-viewport]') ?? findScrollableParent(base)
		if (host === document.scrollingElement || host === document.documentElement) {
			setScrollHost(null)
		} else {
			setScrollHost(host)
		}
	}, [content, headingAnchors.length])

	useEffect((): void | (() => void) => {
		const root = contentRef.current
		if (!root) return undefined
		const fallbackHost = findScrollableParent(root)
		const host =
			scrollHost ??
			(fallbackHost === document.scrollingElement || fallbackHost === document.documentElement
				? null
				: fallbackHost)
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
			resizeObserver = new ResizeObserver(() => {
				updateActive()
			})
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

	const scrollToSection = useCallback((id: string) => {
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
	}, [resolveScrollContainer])

	const tocItems = useMemo(() => buildTree(headingAnchors), [headingAnchors, buildTree])
	const normalizedQuery = query.trim().toLowerCase()
	const filtered = useMemo(() => {
		if (!normalizedQuery) {
			return { items: tocItems, matchCount: headingAnchors.length }
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
			if (selfMatch || nextChildren.length > 0) return { ...node, children: nextChildren }
			return null
		}
		return {
			items: tocItems
				.map((node) => filterNode(node))
				.filter(
					(node): node is { id: string; label: string; depth: number; children: any[] } =>
						Boolean(node),
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

				{content ? (
					<DocMarkdown
						content={content}
						contentRef={contentRef}
						headingAnchors={headingAnchors}
						blockMap={blockMap}
						renderBlock={renderBlock}
					/>
				) : blockEntries.length ? (
					<Stack gap={6}>
						{blockEntries.map((entry) => (
							<Box key={entry.id}>{renderBlock(entry.block)}</Box>
						))}
					</Stack>
				) : null}
			</Stack>
			{hasToc && content && tocItems.length ? (
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
												backgroundColor: isActive
													? 'var(--mantine-color-blue-light)'
													: 'transparent',
												boxShadow: isActive ? 'var(--mantine-shadow-sm)' : 'none',
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
															boxShadow: isActive
																? '0 0 0 3px var(--mantine-color-blue-light)'
																: 'none',
														}}
													/>
													<Text
														size="sm"
														fw={isActive ? 700 : 600}
														style={{ flex: 1, minWidth: 0 }}
														lineClamp={1}
													>
														{item.label}
													</Text>
												</Group>
												{item.children.length ? (
													<Badge variant="light" size="xs" color="gray">
														{item.children.length}
													</Badge>
												) : null}
											</Group>
											{item.children.length ? (
												<Stack gap={6} mt={6}>
													{item.children.map((child: any) => renderNode(child, depth + 1))}
												</Stack>
											) : null}
										</Box>
									)
								}
								return renderNode(node)
							})}
						</Stack>
					) : (
						<Text size="xs" c="dimmed">
							暂无匹配项
						</Text>
					)}
				</FloatingToc>
			) : null}
		</Box>
	)
}
