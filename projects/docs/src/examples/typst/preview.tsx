'use client'

import { useEffect, useRef } from 'react'
import { useTheme } from 'next-themes'
import type { ExampleBlock, ExampleCompilation } from './protocol'

/** The compiler's link rectangles carry layout geometry, including page breaks. */
export function ExamplePreview({
	compilation,
	navigationEnabled,
	selectedBlock,
	onNavigate,
}: {
	compilation: ExampleCompilation
	navigationEnabled: boolean
	selectedBlock?: string
	onNavigate(block: ExampleBlock): void
}) {
	const { resolvedTheme } = useTheme()
	const frame = useRef<HTMLIFrameElement>(null)
	const latest = useRef({ selectedBlock, onNavigate, navigationEnabled })
	latest.current = { selectedBlock, onNavigate, navigationEnabled }

	function highlight() {
		const document = frame.current?.contentDocument
		if (!document) return
		let first: Element | undefined
		for (const link of document.querySelectorAll<SVGAElement>('a[data-editor-block]')) {
			const selected =
				latest.current.navigationEnabled &&
				link.dataset.editorBlock === latest.current.selectedBlock
			link.setAttribute('aria-disabled', String(!latest.current.navigationEnabled))
			link.setAttribute('tabindex', latest.current.navigationEnabled ? '0' : '-1')
			link.toggleAttribute('data-selected', selected)
			if (selected) first ??= link
		}
		const viewport = frame.current?.contentWindow
		if (first && viewport) {
			const bounds = first.getBoundingClientRect()
			if (bounds.top < 20 || bounds.bottom > viewport.innerHeight - 20)
				viewport.scrollTo({ top: viewport.scrollY + bounds.top - 30 })
		}
	}

	useEffect(highlight, [selectedBlock, navigationEnabled])

	function loaded() {
		const document = frame.current?.contentDocument
		if (!document) return
		for (const link of document.querySelectorAll<SVGAElement>('a')) {
			const href = link.getAttributeNS('http://www.w3.org/1999/xlink', 'href')
			const block = compilation.blocks.find((item) => href === `pluxel:preview/${item.id}`)
			if (!block) continue
			link.dataset.editorBlock = block.id
			link.setAttribute('tabindex', '0')
			link.setAttribute('role', 'button')
			link.setAttribute('aria-label', `返回正文：${block.label}`)
			link.removeAttribute('target')
			let pointer: { x: number; y: number } | undefined
			link.addEventListener('pointerdown', (event) => {
				pointer = { x: event.clientX, y: event.clientY }
			})
			link.addEventListener('click', (event) => {
				event.preventDefault()
				if (
					latest.current.navigationEnabled &&
					event.button === 0 &&
					!event.ctrlKey &&
					!event.metaKey &&
					!event.altKey &&
					!event.shiftKey &&
					pointer &&
					Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) <= 4
				)
					latest.current.onNavigate(block)
				pointer = undefined
			})
			link.addEventListener('keydown', (event) => {
				if (latest.current.navigationEnabled && (event.key === 'Enter' || event.key === ' ')) {
					event.preventDefault()
					latest.current.onNavigate(block)
				}
			})
		}
		highlight()
	}

	return (
		<iframe
			ref={frame}
			title="Typst 排版结果"
			sandbox="allow-same-origin"
			onLoad={loaded}
			srcDoc={`<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>
html{color-scheme:${resolvedTheme === 'dark' ? 'dark' : 'light'};background:Canvas}
body{margin:0;padding:20px;background:transparent}
svg{display:block;width:100%;height:auto;background:white;box-shadow:0 2px 12px #0001}
a[data-editor-block]{cursor:pointer;outline:none}
a[aria-disabled=true]{pointer-events:none;cursor:default}
a[data-editor-block] .pseudo-link{fill:transparent;stroke:transparent;stroke-width:1;vector-effect:non-scaling-stroke}
a[data-editor-block]:hover .pseudo-link{fill:#12b88618;stroke:#12b88670}
a[data-selected] .pseudo-link,a[data-editor-block]:focus-visible .pseudo-link{fill:#12b88630;stroke:#087f5b}
</style></head><body>${compilation.svg}</body></html>`}
		/>
	)
}
