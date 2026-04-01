import { Badge, Group, Text } from '@mantine/core'
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useAutoFormCtx } from 'valibot-form/web'
import { findScrollableParent } from '../configAnchors'
import { OutlineNavigator } from '../../detail/workbench/OutlineNavigator'
import {
	usePluginWorkbenchAside,
	usePluginWorkbenchAssistVisibility,
} from '../../detail/workbench/context'

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
	const { assistHost, asideAvailable } = usePluginWorkbenchAside()

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
					return item.id.startsWith(sectionIdPrefix) || item.id.startsWith(fieldIdPrefix)
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

	const assistVisible = anchors.length > 0 && showToc
	usePluginWorkbenchAssistVisibility(assistVisible)

	if (!assistVisible) return null
	if (asideAvailable && !assistHost) return null
	if (!assistHost) return null

	return createPortal(
		<div className="plx-pluginWorkbench__assistSection">
			<OutlineNavigator
				anchors={anchors}
				activeId={activeId}
				onSelect={scrollToSection}
				placeholder="搜索配置项…"
				emptyLabel="暂无匹配项"
				showBranchCount
				header={({ hasQuery, shownCount, totalCount }) => (
					<Group justify="space-between" align="center" gap="xs">
						<Text size="xs" c="dimmed" fw={600}>
							{hasQuery ? `${shownCount}/${totalCount} 项匹配` : `${totalCount} 项`}
						</Text>
						{hasQuery ? (
							<Badge size="xs" variant="light" color="gray">
								筛选中
							</Badge>
						) : null}
					</Group>
				)}
			/>
		</div>,
		assistHost,
	)
}
