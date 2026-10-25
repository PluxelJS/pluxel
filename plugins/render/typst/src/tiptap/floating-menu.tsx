import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import type { Editor } from '@tiptap/core'

export function FloatingMenu({
	editor,
	reference,
	className,
	elementRef,
	onReady,
	children,
}: {
	editor: Editor
	reference(): { left: number; top: number; bottom: number }
	className: string
	elementRef?: RefObject<HTMLDivElement | null>
	onReady?(): void
	children: ReactNode
}) {
	const ownRef = useRef<HTMLDivElement>(null)
	const ref = elementRef ?? ownRef
	const [point, setPoint] = useState<{ left: number; top: number } | null>(null)
	const ready = useRef(onReady)
	ready.current = onReady
	const positioned = point !== null
	useLayoutEffect(() => {
		if (positioned) ready.current?.()
	}, [positioned])
	useLayoutEffect(() => {
		const document = editor.view.dom.ownerDocument
		const window = document.defaultView!
		function position() {
			if (!ref.current || editor.isDestroyed) return
			const target = reference()
			const { width, height } = ref.current.getBoundingClientRect()
			const left = Math.max(8, Math.min(target.left, window.innerWidth - width - 8))
			const top =
				target.bottom + height + 8 < window.innerHeight
					? target.bottom + 8
					: Math.max(8, target.top - height - 8)
			setPoint((previous) =>
				previous?.left === left && previous.top === top ? previous : { left, top },
			)
		}
		position()
		const observer = new ResizeObserver(position)
		if (ref.current) observer.observe(ref.current)
		document.addEventListener('scroll', position, true)
		window.addEventListener('resize', position)
		return () => {
			observer.disconnect()
			document.removeEventListener('scroll', position, true)
			window.removeEventListener('resize', position)
		}
	}, [editor, reference, children, ref])
	return createPortal(
		<div
			ref={ref}
			className={`typst-floating-menu ${className}`}
			style={{
				left: point?.left ?? 0,
				top: point?.top ?? 0,
				visibility: point ? 'visible' : 'hidden',
			}}
		>
			{children}
		</div>,
		editor.view.dom.ownerDocument.body,
	)
}
