import { useEffect, useRef, useState } from 'react'
import { ActionIcon, Alert, Button, Group, NumberInput, Text, Tooltip } from '@mantine/core'
import { IconChevronLeft, IconChevronRight, IconList } from '@tabler/icons-react'
import { createTypstRenderer } from '@myriaddreamin/typst.ts'
import wasmUrl from '@myriaddreamin/typst-ts-renderer/wasm?url'
import { TypstPreviewView } from '@pluxel/typst/browser'
import type { CompileResult } from '../shared/contracts'
import type { WorkspaceController } from './workspace'
import { pointAtPreview, pointAtSource, type SourcePosition } from './source-navigation'

let rendererPromise: ReturnType<typeof initialize> | undefined
async function initialize() {
	const renderer = createTypstRenderer()
	await renderer.init({ getModule: () => wasmUrl })
	return renderer
}

export function Preview({
	result,
	workspace,
	entry,
}: {
	result: CompileResult | null
	workspace: WorkspaceController
	entry: string
}) {
	const root = useRef<HTMLDivElement>(null)
	const container = useRef<HTMLDivElement>(null)
	const scroll = useRef<HTMLDivElement>(null)
	const pages = useRef<SVGGraphicsElement[]>([])
	const displayedResult = useRef<CompileResult | null>(null)
	const [navigation, setNavigation] = useState<CompileResult['preview']['navigation']>()
	const [currentHeading, setCurrentHeading] = useState(-1)
	const mouseDown = useRef<
		{ x: number; y: number; pointerId: number; dragged: boolean } | undefined
	>(undefined)
	const highlight = useRef<SVGRectElement | undefined>(undefined)
	const highlightTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
	const [pageCount, setPageCount] = useState(0)
	const [currentPage, setCurrentPage] = useState(1)
	const [pageInput, setPageInput] = useState<string | number>(1)
	const [navigationOpen, setNavigationOpen] = useState(false)
	function pageTop(page: SVGGraphicsElement) {
		return page.getScreenCTM()?.f ?? page.getBoundingClientRect().top
	}
	function trackPage() {
		if (!scroll.current) return
		const threshold =
			scroll.current.getBoundingClientRect().top + Math.min(120, scroll.current.clientHeight / 3)
		let active = 1
		for (const [index, page] of pages.current.entries()) {
			if (pageTop(page) <= threshold) active = index + 1
		}
		setCurrentPage(active)
		setPageInput(active)
		let heading = -1
		for (const [index, item] of (
			displayedResult.current?.preview.navigation?.outline ?? []
		).entries()) {
			const matrix = pages.current[item.page - 1]?.getScreenCTM()
			if (!matrix) continue
			const position = new DOMPoint(item.x, item.y).matrixTransform(matrix)
			if (position.y <= threshold) heading = index
		}
		setCurrentHeading(heading)
	}
	function jumpToPosition(pageNumber: number, x: number, y: number) {
		const matrix = pages.current[pageNumber - 1]?.getScreenCTM()
		const viewport = scroll.current
		if (!matrix || !viewport) return
		const position = new DOMPoint(x, y).matrixTransform(matrix)
		viewport.scrollTo({
			top:
				viewport.scrollTop +
				position.y -
				viewport.getBoundingClientRect().top -
				viewport.clientHeight / 3,
		})
		setCurrentPage(pageNumber)
		setPageInput(pageNumber)
	}
	function revealPosition(position: SourcePosition) {
		const compiled = displayedResult.current
		if (!compiled || !workspace.isNavigationCurrent(compiled)) return false
		const point = pointAtSource(compiled.preview.navigation?.points ?? [], position, currentPage)
		const page = point && pages.current[point.page - 1]
		if (!point || !page) return false
		jumpToPosition(point.page, point.x, point.y)
		clearTimeout(highlightTimer.current)
		highlight.current?.remove()
		const rectangle = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
		rectangle.classList.add('preview-source-highlight')
		rectangle.setAttribute('x', String(point.x - 2))
		rectangle.setAttribute('y', String(point.y - 2))
		rectangle.setAttribute('width', String(point.width + 4))
		rectangle.setAttribute('height', String(point.height + 4))
		rectangle.setAttribute('rx', '2')
		page.append(rectangle)
		highlight.current = rectangle
		highlightTimer.current = setTimeout(() => {
			rectangle.remove()
			if (highlight.current === rectangle) highlight.current = undefined
		}, 1400)
		return true
	}
	const reveal = useRef(revealPosition)
	reveal.current = revealPosition
	useEffect(() => {
		if (!root.current) return
		return workspace.registerPreview({
			entry,
			element: root.current,
			result: () => displayedResult.current,
			reveal: (position) => reveal.current(position),
		})
	}, [workspace, entry])
	function jumpToPage(requested: number) {
		const next = Math.max(1, Math.min(pages.current.length, Math.round(requested)))
		const page = pages.current[next - 1]
		const viewport = scroll.current
		if (!page || !viewport) return
		viewport.scrollTo({
			top: viewport.scrollTop + pageTop(page) - viewport.getBoundingClientRect().top - 18,
		})
		setCurrentPage(next)
		setPageInput(next)
	}
	function submitPage() {
		const requested = Number(pageInput)
		if (Number.isFinite(requested) && requested > 0) jumpToPage(requested)
		else setPageInput(currentPage)
	}
	const [error, setError] = useState('')
	const displayed = useRef<TypstPreviewView | undefined>(undefined)
	useEffect(
		() => () => {
			clearTimeout(highlightTimer.current)
			highlight.current?.remove()
			void displayed.current?.dispose()
			displayed.current = undefined
			displayedResult.current = null
		},
		[],
	)
	useEffect(() => {
		if (!result || !container.current) return
		let canceled = false
		let view: TypstPreviewView | undefined
		// Keep the last complete page visible until the new artifact has rendered.
		const candidate = document.createElement('div')
		const destination = container.current
		void (async () => {
			const renderer = await (rendererPromise ??= initialize().catch((cause) => {
				rendererPromise = undefined
				throw cause
			}))
			if (canceled) return
			view = new TypstPreviewView({
				container: candidate,
				renderer,
				sessionId: result.preview.sessionId,
			})
			if (result.preview.compilerVersion !== '0.7.0') throw new Error('预览编译器版本不匹配')
			await view.show({
				...result.preview,
				compilerVersion: '0.7.0',
				data: new Uint8Array(result.preview.data),
			})
			if (!canceled) {
				const previous = displayed.current
				destination.replaceChildren(candidate)
				pages.current = [...candidate.querySelectorAll<SVGGraphicsElement>('.typst-page')]
				displayedResult.current = result
				setNavigation(result.preview.navigation)
				setPageCount(pages.current.length)
				trackPage()
				displayed.current = view
				void previous?.dispose()
				setError('')
			}
		})().catch((cause) => {
			if (!canceled) setError(String(cause))
		})
		return () => {
			canceled = true
			if (view !== displayed.current) void view?.dispose()
		}
	}, [result])
	return (
		<div
			ref={root}
			className="document-preview"
			onFocusCapture={() => workspace.preferPreview(entry)}
		>
			{pageCount > 0 && (
				<Group className="preview-toolbar" gap="xs" wrap="nowrap">
					<Tooltip label="目录与页面">
						<ActionIcon
							variant={navigationOpen ? 'light' : 'subtle'}
							aria-label="目录与页面"
							aria-expanded={navigationOpen}
							onClick={() => setNavigationOpen(!navigationOpen)}
						>
							<IconList size={18} />
						</ActionIcon>
					</Tooltip>
					<Group gap={4} wrap="nowrap">
						<ActionIcon
							variant="subtle"
							aria-label="上一页"
							disabled={currentPage <= 1}
							onClick={() => jumpToPage(currentPage - 1)}
						>
							<IconChevronLeft size={17} />
						</ActionIcon>
						<NumberInput
							aria-label="跳转到页"
							size="xs"
							w={58}
							min={1}
							max={pageCount}
							allowDecimal={false}
							hideControls
							value={pageInput}
							onChange={setPageInput}
							onBlur={submitPage}
							onKeyDown={(event) => {
								if (event.key === 'Enter') {
									submitPage()
									event.currentTarget.blur()
								}
							}}
						/>
						<Text size="xs" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
							/ {pageCount} 页
						</Text>
						<ActionIcon
							variant="subtle"
							aria-label="下一页"
							disabled={currentPage >= pageCount}
							onClick={() => jumpToPage(currentPage + 1)}
						>
							<IconChevronRight size={17} />
						</ActionIcon>
					</Group>
				</Group>
			)}
			<div className="preview-body">
				{navigationOpen && pageCount > 0 && (
					<nav className="preview-navigation" aria-label="文档目录与页面">
						{Boolean(navigation?.outline.length) && (
							<>
								<Text size="xs" c="dimmed" mb="xs">
									目录
								</Text>
								{navigation?.outline.map((item, index) => (
									<Button
										key={`${index}:${item.page}:${item.y}`}
										className="preview-heading"
										variant={currentHeading === index ? 'light' : 'subtle'}
										fullWidth
										justify="start"
										size="xs"
										title={item.title}
										aria-current={currentHeading === index ? 'location' : undefined}
										style={{ paddingInlineStart: 8 + Math.min(item.level - 1, 4) * 12 }}
										onClick={() => jumpToPosition(item.page, item.x, item.y)}
									>
										<span className="preview-heading-title">{item.title}</span>
										<span className="preview-heading-page">{item.page}</span>
									</Button>
								))}
							</>
						)}
						<Text size="xs" c="dimmed" mb="xs">
							页面
						</Text>
						{Array.from({ length: pageCount }, (_, index) => (
							<Button
								key={index}
								variant={currentPage === index + 1 ? 'light' : 'subtle'}
								fullWidth
								justify="start"
								size="xs"
								aria-current={currentPage === index + 1 ? 'page' : undefined}
								onClick={() => jumpToPage(index + 1)}
							>
								第 {index + 1} 页
							</Button>
						))}
					</nav>
				)}
				<div ref={scroll} className="preview-scroll" onScroll={trackPage}>
					{error && (
						<Alert color="red" title="预览失败">
							{error}
						</Alert>
					)}
					{!result && (
						<div className="preview-empty">
							<div className="paper-icon">▤</div>
							<Text fw={600}>让数据成为一份文档</Text>
							<Text size="sm" c="dimmed">
								打开模板后，预览会显示在这里
							</Text>
						</div>
					)}
					<div
						ref={container}
						className="typst-pages"
						aria-label="Typst 文档预览，点击内容定位源码"
						onPointerDown={(event) => {
							mouseDown.current =
								event.button === 0 &&
								!event.ctrlKey &&
								!event.metaKey &&
								!event.altKey &&
								!event.shiftKey
									? {
											x: event.clientX,
											y: event.clientY,
											pointerId: event.pointerId,
											dragged: false,
										}
									: undefined
						}}
						onPointerMove={(event) => {
							const start = mouseDown.current
							if (start && Math.hypot(start.x - event.clientX, start.y - event.clientY) > 4)
								start.dragged = true
						}}
						onPointerCancel={() => {
							mouseDown.current = undefined
						}}
						onPointerUp={(event) => {
							const start = mouseDown.current
							mouseDown.current = undefined
							const compiled = displayedResult.current
							if (
								!start ||
								start.dragged ||
								start.pointerId !== event.pointerId ||
								Math.hypot(start.x - event.clientX, start.y - event.clientY) > 4 ||
								!compiled ||
								!workspace.isNavigationCurrent(compiled)
							)
								return
							const element =
								event.target instanceof Element
									? event.target.closest<SVGGraphicsElement>('.typst-page')
									: null
							const pageNumber = element ? pages.current.indexOf(element) + 1 : 0
							const matrix = element?.getScreenCTM()
							if (!pageNumber || !matrix) return
							const local = new DOMPoint(event.clientX, event.clientY).matrixTransform(
								matrix.inverse(),
							)
							const point = pointAtPreview(
								compiled.preview.navigation?.points ?? [],
								pageNumber,
								local.x,
								local.y,
							)
							if (point) void workspace.revealSource(compiled, point)
						}}
					/>
				</div>
			</div>
		</div>
	)
}
