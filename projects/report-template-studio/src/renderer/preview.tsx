import { useEffect, useRef, useState } from 'react'
import { ActionIcon, Alert, Button, Group, NumberInput, Text, Tooltip } from '@mantine/core'
import { IconChevronLeft, IconChevronRight, IconList } from '@tabler/icons-react'
import { createTypstRenderer } from '@myriaddreamin/typst.ts'
import wasmUrl from '@myriaddreamin/typst-ts-renderer/wasm?url'
import { TypstPreviewView, type TypstPreviewState } from '@pluxel/plugin-typst/browser'
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
	const currentWorkspace = useRef(workspace)
	currentWorkspace.current = workspace
	const displayedResult = useRef<PreviewResult | null>(null)
	const [viewState, setViewState] = useState<TypstPreviewState>({
		pageCount: 0,
		currentPage: 1,
		currentHeading: -1,
	})
	const { pageCount, currentPage, currentHeading } = viewState
	const navigation = viewState.preview?.navigation
	const [pageInput, setPageInput] = useState<string | number>(1)
	const [navigationOpen, setNavigationOpen] = useState(false)
	const displayed = useRef<TypstPreviewView | undefined>(undefined)
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
		const requested = Number(pageInput)
		if (Number.isFinite(requested) && requested > 0) displayed.current?.jumpToPage(requested)
		else setPageInput(currentPage)
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
					setPageInput(state.currentPage)
				},
			})
			if (result.preview.compilerVersion !== '0.7.0') throw new Error('预览编译器版本不匹配')
			await view.show(result.preview)
			if (!canceled) {
				const previous = displayed.current
				destination.replaceChildren(candidate)
				displayedResult.current = result
				displayed.current = view
				view.refresh()
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
							onClick={() => displayed.current?.jumpToPage(currentPage - 1)}
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
							onClick={() => displayed.current?.jumpToPage(currentPage + 1)}
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
										onClick={() => displayed.current?.jumpToPosition(item)}
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
								onClick={() => displayed.current?.jumpToPage(index + 1)}
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
