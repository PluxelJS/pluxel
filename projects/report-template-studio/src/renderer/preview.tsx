import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { ActionIcon, Alert, Button, Group, Text, Tooltip } from '@mantine/core'
import { IconChevronLeft, IconChevronRight, IconList, IconX } from '@tabler/icons-react'
import { createTypstRenderer } from '@myriaddreamin/typst.ts'
import wasmUrl from '@myriaddreamin/typst-ts-renderer/wasm?url'
import {
	TypstPreviewView,
	type TypstPreviewState,
	type TypstPreviewZoom,
} from '@pluxel/plugin-typst/browser'
import type { PreviewResult } from '../shared/contracts'
import type { WorkspaceController } from './workspace'

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
	result: PreviewResult | null
	workspace: WorkspaceController
	entry: string
}) {
	const root = useRef<HTMLDivElement>(null)
	const container = useRef<HTMLDivElement>(null)
	const scroll = useRef<HTMLDivElement>(null)
	const navigationElement = useRef<HTMLElement>(null)
	const navigationToggle = useRef<HTMLButtonElement>(null)
	const navigationId = useId()
	const currentWorkspace = useRef(workspace)
	currentWorkspace.current = workspace
	const displayedResult = useRef<PreviewResult | null>(null)
	const [viewState, setViewState] = useState<TypstPreviewState>({
		pageCount: 0,
		currentPage: 1,
		currentHeading: -1,
		zoom: 'fit-width',
	})
	const { pageCount, currentPage, currentHeading, zoom } = viewState
	const navigation = viewState.preview?.navigation
	const [pageDraft, setPageDraft] = useState<string | null>(null)
	const cancelPage = useRef(false)
	const [navigationOpen, setNavigationOpen] = useState(false)
	const displayed = useRef<TypstPreviewView | undefined>(undefined)
	useLayoutEffect(() => {
		const nav = navigationElement.current
		if (!navigationOpen || !nav) return
		const active = nav.querySelector<HTMLElement>(
			currentHeading >= 0 ? '[aria-current="location"]' : '[aria-current="page"]',
		)
		if (!active) return
		const bounds = nav.getBoundingClientRect()
		const item = active.getBoundingClientRect()
		const top =
			bounds.top +
			(nav.querySelector<HTMLElement>('.preview-navigation-header')?.offsetHeight ?? 0) +
			4
		if (item.top < top) nav.scrollTop += item.top - top
		else if (item.bottom > bounds.bottom - 4) nav.scrollTop += item.bottom - bounds.bottom + 4
	}, [navigationOpen, currentHeading, currentPage, navigation])
	useEffect(() => {
		if (!root.current) return
		return workspace.registerPreview({
			entry,
			element: root.current,
			result: () => displayedResult.current,
			reveal: (position) => displayed.current?.revealSource(position) ?? false,
		})
	}, [workspace, entry])
	function submitPage() {
		if (pageDraft !== null && !cancelPage.current && /^\d+$/.test(pageDraft.trim())) {
			const requested = Number(pageDraft)
			if (Number.isSafeInteger(requested) && requested >= 1 && requested <= pageCount)
				displayed.current?.jumpToPage(requested)
		}
		cancelPage.current = false
		setPageDraft(null)
	}
	function closeNavigation() {
		setNavigationOpen(false)
		navigationToggle.current?.focus()
	}
	function closeNavigationOverlay() {
		const nav = navigationElement.current
		if (nav && getComputedStyle(nav).position === 'absolute') closeNavigation()
	}
	function navigationKey(event: KeyboardEvent<HTMLButtonElement>) {
		if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
			event.preventDefault()
			event.stopPropagation()
			closeNavigation()
		}
	}
	const [error, setError] = useState('')
	useEffect(
		() => () => {
			void displayed.current?.dispose()
			displayed.current = undefined
			displayedResult.current = null
		},
		[],
	)
	useEffect(() => {
		if (!result || !container.current || !scroll.current) return
		let canceled = false
		let view: TypstPreviewView | undefined
		// Keep the last complete page visible until the new artifact has rendered.
		const candidate = document.createElement('div')
		const destination = container.current
		const viewport = scroll.current
		void (async () => {
			const renderer = await (rendererPromise ??= initialize().catch((cause) => {
				rendererPromise = undefined
				throw cause
			}))
			if (canceled) return
			view = new TypstPreviewView({
				container: candidate,
				scrollContainer: viewport,
				renderer,
				sessionId: result.preview.sessionId,
				isNavigationCurrent: () =>
					displayed.current === view &&
					currentWorkspace.current === workspace &&
					workspace.isNavigationCurrent(result),
				onNavigate: ({ point }) => {
					void workspace.revealSource(result, point)
				},
				onStateChange: (state) => {
					if (displayed.current !== view) return
					setViewState(state)
				},
			})
			if (result.preview.compilerVersion !== '0.7.0') throw new Error('预览编译器版本不匹配')
			await view.show(result.preview)
			if (!canceled) {
				const previous = displayed.current
				destination.replaceChildren(candidate)
				displayedResult.current = result
				displayed.current = view
				view.setZoom(previous?.state.zoom ?? 'fit-width')
				view.refresh()
				setViewState(view.state)
				void previous?.dispose()
				setError('')
			}
		})().catch(async (cause) => {
			if (view !== displayed.current) await view?.dispose()
			if (!canceled) setError(String(cause))
		})
		return () => {
			canceled = true
			if (view !== displayed.current) void view?.dispose()
		}
	}, [result, workspace])
	return (
		<div
			ref={root}
			className="document-preview"
			data-preview-current={Boolean(
				displayedResult.current && workspace.isNavigationCurrent(displayedResult.current),
			)}
			data-preview-revision={viewState.preview?.revision}
			onFocusCapture={() => workspace.preferPreview(entry)}
		>
			{pageCount > 0 && (
				<Group className="preview-toolbar" gap={4} wrap="nowrap">
					<Tooltip label="目录与页面">
						<ActionIcon
							ref={navigationToggle}
							size="sm"
							variant={navigationOpen ? 'light' : 'subtle'}
							aria-label="目录与页面"
							aria-expanded={navigationOpen}
							aria-controls={navigationId}
							onClick={() => setNavigationOpen(!navigationOpen)}
						>
							<IconList size={18} />
						</ActionIcon>
					</Tooltip>
					<Group gap={4} wrap="nowrap">
						<ActionIcon
							size="sm"
							variant="subtle"
							aria-label="上一页"
							title="上一页"
							disabled={currentPage <= 1}
							onClick={() => displayed.current?.jumpToPage(currentPage - 1)}
						>
							<IconChevronLeft size={17} />
						</ActionIcon>
						<input
							className="preview-page-input"
							aria-label="跳转到页"
							title="输入页码后按 Enter 或移开焦点跳转，Esc 取消"
							inputMode="numeric"
							value={pageDraft ?? String(currentPage)}
							onFocus={() => setPageDraft(String(currentPage))}
							onChange={(event) => setPageDraft(event.currentTarget.value)}
							onBlur={submitPage}
							onKeyDown={(event) => {
								if (event.nativeEvent.isComposing) return
								if (event.key === 'Enter' || event.key === 'Escape') {
									event.preventDefault()
									event.stopPropagation()
									cancelPage.current = event.key === 'Escape'
									event.currentTarget.blur()
								}
							}}
						/>
						<Text size="xs" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
							/ {pageCount}
						</Text>
						<ActionIcon
							size="sm"
							variant="subtle"
							aria-label="下一页"
							title="下一页"
							disabled={currentPage >= pageCount}
							onClick={() => displayed.current?.jumpToPage(currentPage + 1)}
						>
							<IconChevronRight size={17} />
						</ActionIcon>
					</Group>
					<select
						className="preview-zoom"
						aria-label="预览缩放"
						value={zoom}
						onChange={(event) => {
							const value = event.currentTarget.value
							const requested: TypstPreviewZoom =
								value === 'fit-width' || value === 'fit-page' ? value : Number(value)
							displayed.current?.setZoom(requested)
						}}
					>
						<option value="fit-width">适合宽度</option>
						<option value="fit-page">适合整页</option>
						{[0.5, 0.75, 1, 1.25, 1.5, 2].map((value) => (
							<option key={value} value={value}>
								{value * 100}%
							</option>
						))}
					</select>
				</Group>
			)}
			<div className="preview-body">
				{navigationOpen && pageCount > 0 && (
					<nav
						ref={navigationElement}
						id={navigationId}
						className="preview-navigation"
						aria-label="文档目录与页面"
					>
						<div className="preview-navigation-header">
							<Text size="xs" fw={600}>
								目录与页面
							</Text>
							<ActionIcon
								size="xs"
								variant="subtle"
								aria-label="关闭目录与页面"
								title="关闭目录与页面"
								onClick={closeNavigation}
								onKeyDown={navigationKey}
							>
								<IconX size={14} />
							</ActionIcon>
						</div>
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
										aria-label={`${item.title}，第 ${item.page} 页`}
										aria-current={currentHeading === index ? 'location' : undefined}
										style={{ paddingInlineStart: 8 + Math.min(item.level - 1, 4) * 12 }}
										onClick={() => {
											if (displayed.current?.jumpToPosition(item)) closeNavigationOverlay()
										}}
										onKeyDown={navigationKey}
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
								onClick={() => {
									if (displayed.current?.jumpToPage(index + 1)) closeNavigationOverlay()
								}}
								onKeyDown={navigationKey}
							>
								第 {index + 1} 页
							</Button>
						))}
					</nav>
				)}
				<div ref={scroll} className="preview-scroll">
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
					/>
				</div>
			</div>
		</div>
	)
}
