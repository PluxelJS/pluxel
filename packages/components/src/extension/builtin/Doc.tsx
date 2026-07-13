import { Badge, Box, Paper, Stack, Text, Typography } from '@mantine/core'
import { MarkdownExit } from 'markdown-exit'
import { createPortal } from 'react-dom'
import {
	Fragment,
	memo,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	type ReactNode,
	type RefObject,
} from 'react'
import type {
	BuiltinDocBlock,
	BuiltinDocContent,
	BuiltinDocExtensionDef,
	BuiltinMarkdownPart,
	BuiltinDocPart,
} from '@pluxel/runtime/web/extensions'
import { findScrollableParent, toDomSlug } from '../../app/plugins/config/configAnchors'
import { BuiltinSignalDbAction } from './SignalDbAction'
import { BuiltinInfoCard } from './InfoCard'
import { BuiltinResourceSelect } from './ResourceSelect'
import { BuiltinSignalDbForm } from './SignalDbForm'
import { usePluginConfig } from '../../app/plugins/config/usePluginConfig'
import type { ObjectSchema } from 'valibot'
import { ConfigTabContent } from '../../app/plugins/config/ConfigTab'
import { compareSchemaKeys } from '../../app/plugins/config/schemaKey'
import { OutlineNavigator } from '../../app/plugins/detail/workbench/OutlineNavigator'
import type { OutlineAnchor } from '../../app/plugins/detail/workbench/outline'
import { usePluginWorkbenchTabActivity } from '../../app/plugins/detail/workbench/tabActivity'
import {
	usePluginWorkbenchAside,
	usePluginWorkbenchAssistVisibility,
} from '../../app/plugins/detail/workbench/context'

type DocConfigDirective = Extract<BuiltinMarkdownPart, { kind: 'schema' | 'schemas' }>

type CompiledItem =
	| { kind: 'html'; key: string; html: string }
	| { kind: 'block'; key: string; id: string; title: string; block: BuiltinDocBlock }
	| { kind: 'cfg'; key: string; directive: DocConfigDirective }

type BuiltinBlockRendererProps = {
	pluginName: string
	title: string
	block: BuiltinDocBlock
}

function renderBuiltinBlock(input: BuiltinBlockRendererProps): ReactNode {
	const { pluginName, title, block } = input
	if (block.kind === 'infoCard') {
		if (typeof BuiltinInfoCard !== 'function') {
			return <BuiltinBlockUnavailable kind={block.kind} />
		}
		return <BuiltinInfoCard pluginName={pluginName} block={block} />
	}
	if (block.kind === 'form') {
		if (typeof BuiltinSignalDbForm !== 'function') {
			return <BuiltinBlockUnavailable kind={block.kind} />
		}
		return <BuiltinSignalDbForm pluginName={pluginName} title={title} block={block} />
	}
	if (block.kind === 'action') {
		if (typeof BuiltinSignalDbAction !== 'function') {
			return <BuiltinBlockUnavailable kind={block.kind} />
		}
		return <BuiltinSignalDbAction pluginName={pluginName} block={block} />
	}
	if (block.kind === 'resourceSelect') {
		if (typeof BuiltinResourceSelect !== 'function') {
			return <BuiltinBlockUnavailable kind={block.kind} />
		}
		return (
			<BuiltinResourceSelect
				targetPluginName={pluginName}
				sourcePluginName={pluginName}
				block={block}
			/>
		)
	}
	return <BuiltinBlockUnavailable kind={(block as BuiltinDocBlock).kind} />
}

function BuiltinBlockUnavailable({ kind }: { kind: string }) {
	return (
		<Paper withBorder radius="md" p="sm" my="sm">
			<Text size="sm" c="red">
				Builtin block renderer unavailable: {kind}
			</Text>
		</Paper>
	)
}

function BuiltinConfigRendererUnavailable() {
	return (
		<Paper withBorder radius="md" p="sm" my="sm">
			<Text size="sm" c="red">
				Builtin config renderer unavailable
			</Text>
		</Paper>
	)
}

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

function compileDoc(input: { content: BuiltinDocContent; docPrefix: string }): {
	items: CompiledItem[]
	anchors: OutlineAnchor[]
} {
	const { content, docPrefix } = input
	const engine = new MarkdownExit({ html: false, linkify: true })
	const env: Record<string, unknown> = {}

	const seen = new Map<string, number>()
	const anchors: OutlineAnchor[] = []
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

		if (part.kind === 'schema') {
			const key = String(part.key ?? '').trim()
			if (key)
				items.push({
					kind: 'cfg',
					key: `cfg-${items.length + 1}`,
					directive: { kind: 'schema', key },
				})
			continue
		}
		if (part.kind === 'schemas') {
			const keys = part.keys
			items.push({
				kind: 'cfg',
				key: `cfg-${items.length + 1}`,
				directive: {
					kind: 'schemas',
					keys: Array.isArray(keys) ? keys.map(String) : null,
				},
			})
			continue
		}

		const text =
			part.kind === 'md' ? (typeof (part as any).text === 'string' ? (part as any).text : '') : ''
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
	renderCfg,
}: {
	items: CompiledItem[]
	contentRef: RefObject<HTMLDivElement>
	renderBlock: (title: string, block: BuiltinDocBlock) => ReactNode
	renderCfg: (directive: CompiledItem & { kind: 'cfg' }) => ReactNode
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
			<Typography>
				{items.map((item) => {
					if (item.kind === 'cfg')
						return <Fragment key={item.key}>{renderCfg(item as any)}</Fragment>
					if (item.kind === 'block')
						return (
							<Box key={item.key} my="sm">
								<Box component="h2" id={item.id} style={{ scrollMarginTop: 72 }}>
									{item.title}
								</Box>
								{renderBlock(item.title, item.block)}
							</Box>
						)
					// oxlint-disable-next-line react/no-danger -- HTML comes from our markdown renderer for trusted builtin docs.
					return <Box key={item.key} dangerouslySetInnerHTML={{ __html: item.html }} />
				})}
			</Typography>
		</Box>
	)
})

export function BuiltinDoc({ def }: { def: BuiltinDocExtensionDef }) {
	const contentRef = useRef<HTMLDivElement | null>(null)
	const [activeId, setActiveId] = useState<string | null>(null)
	const [scrollHost, setScrollHost] = useState<HTMLElement | null>(null)
	const { assistHost, asideAvailable } = usePluginWorkbenchAside()
	const tabActive = usePluginWorkbenchTabActivity()

	const docPrefix = useMemo(
		() => `doc-${toDomSlug(def.pluginName)}-${toDomSlug(def.id)}-`,
		[def.id, def.pluginName],
	)

	const pluginName = def.pluginName

	// Track used schema keys across the rendered doc so `d.schemas()` behaves like cfg layout.
	const usedSchemaKeysRef = useRef<Set<string> | null>(null)
	usedSchemaKeysRef.current = usedSchemaKeysRef.current ?? new Set<string>()
	usedSchemaKeysRef.current.clear()

	const renderBlock = useCallback(
		(title: string, block: BuiltinDocBlock) => {
			const blockPluginName =
				typeof (block as any)?.pluginName === 'string' && (block as any).pluginName.trim()
					? (block as any).pluginName.trim()
					: pluginName
			return renderBuiltinBlock({
				pluginName: blockPluginName,
				title,
				block,
			})
		},
		[pluginName],
	)

	function toRecord(value: unknown): Record<string, any> {
		if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
		return value as Record<string, any>
	}

	function DocCfgDirective({ directive }: { directive: DocConfigDirective }) {
		const cfg = usePluginConfig(pluginName)
		const data = cfg.data
		const schemaMapAll = (data?.schemaMap ?? {}) as Record<string, ObjectSchema<any, any>>
		const defaultsAll = (data?.defaults ?? {}) as Record<string, unknown>
		const savedAll = (data?.savedConfig ?? {}) as Record<string, unknown>

		const schemaKeys = useMemo(
			() => Object.keys(schemaMapAll ?? {}).sort(compareSchemaKeys),
			[schemaMapAll],
		)

		if (cfg.loading && !cfg.data) return null
		if (cfg.error) {
			return (
				<Paper withBorder radius="md" p="sm" my="sm">
					<Text size="sm" c="red">
						Failed to load config: {cfg.error.message}
					</Text>
				</Paper>
			)
		}

		const used = usedSchemaKeysRef.current ?? new Set<string>()
		const resolveKeys = (): string[] => {
			if (directive.kind === 'schema') {
				const key = String(directive.key ?? '').trim()
				if (!key) return []
				if (used.has(key)) return []
				used.add(key)
				return [key]
			}

			if (directive.keys === null) {
				const remaining = schemaKeys.filter((k) => !used.has(k))
				for (const k of remaining) used.add(k)
				return remaining
			}

			const out: string[] = []
			for (const raw of directive.keys ?? []) {
				const key = String(raw ?? '').trim()
				if (!key) continue
				if (used.has(key)) continue
				used.add(key)
				out.push(key)
			}
			return out
		}

		const keys = resolveKeys()
		if (keys.length === 0) return null

		return (
			<Box my="sm">
				{keys.map((schemaKey) => {
					const schema = schemaMapAll?.[schemaKey]
					if (!schema) {
						return (
							<Paper key={`cfg-unknown-${schemaKey}`} withBorder radius="md" p="sm" my="sm">
								<Text size="sm" c="red">
									Unknown schema key: {schemaKey}
								</Text>
							</Paper>
						)
					}

					return (
						<Box key={`cfg-schema-${schemaKey}`} my="sm">
							{typeof ConfigTabContent === 'function' ? (
								<ConfigTabContent
									pluginName={pluginName}
									tabKey={schemaKey}
									schema={schema}
									savedValue={toRecord(savedAll?.[schemaKey])}
									defaultValue={toRecord(defaultsAll?.[schemaKey])}
									showToc={false}
									active={true}
								/>
							) : (
								<BuiltinConfigRendererUnavailable />
							)}
						</Box>
					)
				})}
			</Box>
		)
	}

	const renderCfg = useCallback(
		(item: CompiledItem & { kind: 'cfg' }) => {
			return <DocCfgDirective directive={item.directive as any} />
		},
		[pluginName],
	)

	const compiled = useMemo(
		() =>
			compileDoc({
				content: def.content,
				docPrefix,
			}),
		[def.content, docPrefix],
	)

	const headingAnchors = compiled.anchors
	const hasToc = headingAnchors.length > 1

	const hasHeader = Boolean(def.title || def.description)
	const shouldRender = compiled.items.length > 0 || hasHeader

	const resolveScrollContainer = useCallback(
		(target: HTMLElement | null) => {
			if (!target) return null
			const candidate =
				(scrollHost && scrollHost.contains(target) ? scrollHost : null) ??
				target.closest<HTMLElement>('[data-scroll-area-viewport]') ??
				findScrollableParent(target)
			if (!candidate) return null
			if (candidate === document.scrollingElement || candidate === document.documentElement)
				return null
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

		const firstAnchorEl = headingAnchors[0]?.id
			? document.getElementById(headingAnchors[0].id)
			: null
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

	const scrollToSection = useCallback(
		(id: string) => {
			if (!id) return
			const target = document.getElementById(id)
			if (!target) return
			const scrollMarginTop =
				Number.parseFloat(getComputedStyle(target).scrollMarginTop || '0') || 0
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

	const tocVisible = hasToc && compiled.items.length > 0 && headingAnchors.length > 0 && tabActive
	usePluginWorkbenchAssistVisibility(tocVisible)

	if (!shouldRender) return null

	const headerContent =
		def.title || def.description ? (
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
		) : null

	const bodyContent =
		compiled.items.length > 0 ? (
			<DocBody
				items={compiled.items}
				contentRef={contentRef}
				renderBlock={renderBlock}
				renderCfg={renderCfg}
			/>
		) : null

	const renderInlineToc = () => (
		<Paper withBorder radius="md" p="sm">
			<OutlineNavigator
				anchors={headingAnchors}
				activeId={activeId}
				onSelect={scrollToSection}
				placeholder="搜索章节…"
				emptyLabel="未找到匹配章节"
				header={({ hasQuery, shownCount, totalCount }) => (
					<>
						<Box
							style={{
								display: 'flex',
								justifyContent: 'space-between',
								alignItems: 'center',
								gap: 8,
							}}
						>
							<Text size="sm" fw={700}>
								文档导航
							</Text>
							<Badge size="xs" variant="light" color="gray">
								{hasQuery ? `${shownCount}/${totalCount}` : totalCount}
							</Badge>
						</Box>
						<Text size="xs" c="dimmed">
							搜索或点击跳转到对应章节。
						</Text>
					</>
				)}
			/>
		</Paper>
	)

	const renderSidebarToc = () => (
		<div className="plx-pluginWorkbench__assistSection">
			<OutlineNavigator
				anchors={headingAnchors}
				activeId={activeId}
				onSelect={scrollToSection}
				placeholder="搜索章节…"
				emptyLabel="未找到匹配章节"
				header={({ hasQuery, shownCount, totalCount }) => (
					<Box
						style={{
							display: 'flex',
							justifyContent: 'space-between',
							alignItems: 'center',
							gap: 8,
						}}
					>
						<Text size="xs" c="dimmed" fw={600}>
							{hasQuery ? `${shownCount}/${totalCount} 项匹配` : `${totalCount} 项`}
						</Text>
						{hasQuery ? (
							<Badge size="xs" variant="light" color="gray">
								筛选中
							</Badge>
						) : null}
					</Box>
				)}
			/>
		</div>
	)

	const documentContent = (
		<Box>
			<Stack gap="xs">
				{headerContent}
				{bodyContent}
			</Stack>
		</Box>
	)

	if (tocVisible && asideAvailable && !assistHost) {
		return documentContent
	}

	return (
		<>
			{documentContent}
			{tocVisible
				? assistHost
					? createPortal(renderSidebarToc(), assistHost)
					: renderInlineToc()
				: null}
		</>
	)
}
