import { useEffect, useState, type RefObject } from 'react'
import { OutlineNavigator } from './OutlineNavigator'
import type { OutlineAnchor } from './outline'

/** Read rendered heading text, including inline formatting, within this document only. */
export function ContentOutline({ hostRef }: { hostRef: RefObject<HTMLDivElement | null> }) {
	const [anchors, setAnchors] = useState<OutlineAnchor[]>([])
	const [activeId, setActiveId] = useState<string | null>(null)

	useEffect((): (() => void) | undefined => {
		const host = hostRef.current
		if (!host) return undefined
		let frame = 0
		const updateActive = () => {
			const top = host.getBoundingClientRect().top + 32
			const headings = Array.from(
				host.querySelectorAll<HTMLElement>('h1[id],h2[id],h3[id],h4[id],h5[id],h6[id]'),
			)
			let current = headings[0]
			for (const heading of headings) {
				if (heading.getBoundingClientRect().top > top) break
				current = heading
			}
			setActiveId(current?.id ?? null)
		}
		const scan = () => {
			setAnchors(
				Array.from(
					host.querySelectorAll<HTMLElement>('h1[id],h2[id],h3[id],h4[id],h5[id],h6[id]'),
					(heading) => ({
						id: heading.id,
						label: heading.textContent?.trim() || heading.id,
						depth: Number(heading.tagName.slice(1)),
					}),
				),
			)
			updateActive()
		}
		const onScroll = () => {
			cancelAnimationFrame(frame)
			frame = requestAnimationFrame(updateActive)
		}
		scan()
		const observer = new MutationObserver(scan)
		observer.observe(host, { childList: true, subtree: true, characterData: true })
		host.addEventListener('scroll', onScroll, { passive: true })
		return () => {
			observer.disconnect()
			host.removeEventListener('scroll', onScroll)
			cancelAnimationFrame(frame)
		}
	}, [hostRef])

	if (anchors.length === 0) return null
	return (
		<div className="plx-documentOutline">
			<OutlineNavigator
				anchors={anchors}
				activeId={activeId}
				placeholder="搜索标题…"
				emptyLabel="暂无匹配标题"
				onSelect={(id) => {
					const host = hostRef.current
					const heading = Array.from(
						host?.querySelectorAll<HTMLElement>('h1[id],h2[id],h3[id],h4[id],h5[id],h6[id]') ?? [],
					).find((candidate) => candidate.id === id)
					if (!host || !heading) return
					host.scrollTo({
						top:
							host.scrollTop +
							heading.getBoundingClientRect().top -
							host.getBoundingClientRect().top -
							24,
					})
					heading.focus({ preventScroll: true })
					setActiveId(id)
				}}
			/>
		</div>
	)
}
