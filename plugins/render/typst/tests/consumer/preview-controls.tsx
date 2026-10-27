import { useEffect, useRef } from 'react'
import type { TypstPreviewState, TypstPreviewView } from '@pluxel/plugin-typst/browser'

/** Page input is a local draft until Enter or blur; scrolling cannot overwrite it. */
export function PreviewPageControl({
	state,
	view,
}: {
	state: TypstPreviewState
	view?: TypstPreviewView
}) {
	const input = useRef<HTMLInputElement>(null)
	const editing = useRef(false)
	const canceled = useRef(false)
	useEffect(() => {
		if (input.current && !editing.current) input.current.value = String(state.currentPage)
	}, [state.currentPage])
	return (
		<div className="preview-pager">
			<button
				type="button"
				aria-label="上一页"
				title="上一页"
				disabled={state.currentPage <= 1 || !state.pageCount}
				onClick={() => view?.jumpToPage(state.currentPage - 1)}
			>
				‹
			</button>
			<input
				ref={input}
				type="number"
				inputMode="numeric"
				aria-label="跳转到页"
				title="输入页码，Enter 跳转，Esc 取消"
				min={1}
				max={state.pageCount}
				step={1}
				defaultValue={state.currentPage}
				disabled={!state.pageCount}
				onFocus={() => {
					editing.current = true
					canceled.current = false
				}}
				onBlur={(event) => {
					editing.current = false
					const requested = event.currentTarget.valueAsNumber
					if (
						!canceled.current &&
						event.currentTarget.validity.valid &&
						Number.isSafeInteger(requested)
					)
						view?.jumpToPage(requested)
					event.currentTarget.value = String(view?.state.currentPage ?? state.currentPage)
				}}
				onKeyDown={(event) => {
					if (event.nativeEvent.isComposing) return
					if (event.key === 'Escape') {
						event.preventDefault()
						canceled.current = true
						event.currentTarget.blur()
					} else if (event.key === 'Enter') {
						event.preventDefault()
						if (event.currentTarget.reportValidity()) event.currentTarget.blur()
					}
				}}
			/>
			<span className="preview-page-count">/ {state.pageCount}</span>
			<button
				type="button"
				aria-label="下一页"
				title="下一页"
				disabled={state.currentPage >= state.pageCount}
				onClick={() => view?.jumpToPage(state.currentPage + 1)}
			>
				›
			</button>
			<output className="sr-only" data-testid="page">
				{state.currentPage} / {state.pageCount}
			</output>
		</div>
	)
}

export function PreviewOutline({
	state,
	view,
	open,
	onClose,
}: {
	state: TypstPreviewState
	view?: TypstPreviewView
	open: boolean
	onClose(): void
}) {
	const root = useRef<HTMLElement>(null)
	function revealActive() {
		const nav = root.current
		const active = nav?.querySelector<HTMLElement>('[aria-current="location"]')
		if (!nav?.clientHeight || !active) return
		const bounds = nav.getBoundingClientRect()
		const item = active.getBoundingClientRect()
		if (item.top < bounds.top + 4) nav.scrollTop += item.top - bounds.top - 4
		else if (item.bottom > bounds.bottom - 4) nav.scrollTop += item.bottom - bounds.bottom + 4
	}
	useEffect(revealActive, [state.currentHeading, state.preview, open])
	useEffect(() => {
		const observer = new ResizeObserver(revealActive)
		if (root.current) observer.observe(root.current)
		return () => observer.disconnect()
	}, [])
	return (
		<nav
			ref={root}
			id="preview-outline"
			className="preview-outline"
			aria-label="目录"
			hidden={!open}
		>
			{state.preview?.navigation.outline.map((item, index) => (
				<button
					type="button"
					key={index}
					title={item.title}
					aria-label={item.title}
					aria-current={state.currentHeading === index ? 'location' : undefined}
					onKeyDown={(event) => {
						if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
							event.preventDefault()
							onClose()
						}
					}}
					style={{ paddingInlineStart: 8 + Math.min(Math.max(item.level - 1, 0), 3) * 10 }}
					onClick={() => {
						if (
							view?.jumpToPosition(item) &&
							root.current &&
							getComputedStyle(root.current).position === 'absolute'
						)
							onClose()
					}}
				>
					<span>{item.title}</span>
					<small>{item.page}</small>
				</button>
			))}
		</nav>
	)
}
