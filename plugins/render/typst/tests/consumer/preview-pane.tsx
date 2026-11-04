import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createTypstRenderer } from '@myriaddreamin/typst.ts/renderer'
import wasmUrl from '@myriaddreamin/typst-ts-renderer/wasm?url'
import {
	TypstPreviewView,
	type SourcePosition,
	type TypstPreview,
	type TypstPreviewState,
	type TypstDiagnostic,
} from '@pluxel/plugin-typst/browser'
import {
	findTypstSourcePosition,
	type TypstSourceProject,
} from '@pluxel/plugin-typst/source/browser'
import type { Editor } from '@tiptap/core'
import { PreviewPageControl, PreviewOutline } from './preview-controls'
import { diagnosticPosition, type ConsumerFailure } from './compile-contract'
import type { ExampleId } from './examples'

interface Compiled {
	clientRevision: number
	preview: TypstPreview
	diagnostics: readonly TypstDiagnostic[]
}

interface PreviewSelection {
	path: string
	position: number
	explicit: boolean
	serial: number
	/** Retains the native paragraph-end caret fallback when its editor is still mounted. */
	editor?: Editor
}

/** One mounted folder preview owns one compiler session; routing and editor drafts belong to the host. */
export function PreviewPane({
	project,
	folder,
	selection,
	hasPending = false,
	onNavigate,
	onIssue,
}: {
	project: TypstSourceProject
	folder: ExampleId
	selection?: PreviewSelection
	/** Unapplied inputs in this folder, including retained editor tabs. */
	hasPending?: boolean
	onNavigate(position: SourcePosition): void
	onIssue(message: string): void
}) {
	const revision = useSyncExternalStore(project.subscribe, () => project.revision)
	const [clientId] = useState(() => crypto.randomUUID())
	const [compiled, setCompiled] = useState<Compiled>()
	const [failure, setFailure] = useState<ConsumerFailure>()
	const [busy, setBusy] = useState(false)
	const [outline, setOutline] = useState(false)
	const [following, setFollowing] = useState(true)
	const [locationStatus, setLocationStatus] = useState('点击正文即可定位预览')
	const [displayedRevision, setDisplayedRevision] = useState<number>()
	const [viewState, setViewState] = useState<TypstPreviewState>({
		pageCount: 0,
		currentPage: 1,
		currentHeading: -1,
		zoom: 'fit-width',
	})
	const previewCurrent = displayedRevision === revision
	const application = folder === 'application-form'
	const container = useRef<HTMLDivElement>(null)
	const viewport = useRef<HTMLDivElement>(null)
	const view = useRef<TypstPreviewView | undefined>(undefined)
	const displayed = useRef<Compiled | undefined>(undefined)
	const sourceSelection = useRef<PreviewSelection | undefined>(undefined)
	const latest = useRef({ onNavigate, onIssue, hasPending, following })
	latest.current = { onNavigate, onIssue, hasPending, following }
	const post = (url: string, body: unknown, signal?: AbortSignal) =>
		fetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'X-Typst-Client': clientId },
			body: JSON.stringify(body),
			signal,
		})

	useEffect(() => {
		const controller = new AbortController()
		setBusy(true)
		setFailure(undefined)
		const timer = setTimeout(() => {
			const snapshot = project.snapshot()
			void post(
				'/compile',
				{ files: snapshot.files, revision: snapshot.revision },
				controller.signal,
			)
				.then(async (response) => {
					const result = await response.json()
					if (controller.signal.aborted) return
					if (!response.ok) {
						setFailure(result)
						return
					}
					setFailure(undefined)
					return setCompiled({
						...result,
						preview: { ...result.preview, data: Uint8Array.from(result.preview.data) },
					})
				})
				.catch((error) => {
					if (!controller.signal.aborted) latest.current.onIssue(String(error))
				})
				.finally(() => {
					if (!controller.signal.aborted) setBusy(false)
				})
		}, 350)
		return () => {
			clearTimeout(timer)
			controller.abort()
		}
	}, [project, revision])

	function navigate(position: SourcePosition) {
		if (displayed.current?.clientRevision !== project.revision) return
		const path = position.path.replace(/^\//, '')
		if (Object.hasOwn(project.snapshot().files, path)) latest.current.onNavigate(position)
	}
	useEffect(() => {
		if (!compiled || !container.current || !viewport.current) return
		let canceled = false
		void (async () => {
			if (!view.current) {
				const renderer = createTypstRenderer()
				await renderer.init({ getModule: () => wasmUrl })
				if (canceled || !container.current || !viewport.current) return
				view.current = new TypstPreviewView({
					container: container.current,
					scrollContainer: viewport.current,
					renderer,
					sessionId: compiled.preview.sessionId,
					onStateChange: setViewState,
					isNavigationCurrent: () => displayed.current?.clientRevision === project.revision,
					onNavigate: ({ point }) => navigate(point),
				})
			}
			if (canceled) return
			if (await view.current.show(compiled.preview)) {
				displayed.current = compiled
				setDisplayedRevision(compiled.clientRevision)
			}
		})().catch((error) => {
			if (!canceled) latest.current.onIssue(String(error))
		})
		return () => {
			canceled = true
		}
	}, [compiled, project])
	useEffect(() => {
		const close = () => {
			void fetch('/session/close', {
				method: 'POST',
				keepalive: true,
				headers: { 'Content-Type': 'application/json', 'X-Typst-Client': clientId },
				body: '{}',
			}).catch((error) => latest.current.onIssue(String(error)))
		}
		window.addEventListener('pagehide', close)
		return () => {
			window.removeEventListener('pagehide', close)
			void view.current?.dispose().catch((error) => latest.current.onIssue(String(error)))
			close()
		}
	}, [clientId])

	function revealSelection() {
		const selected = sourceSelection.current
		if (!selected || (!latest.current.following && !selected.explicit)) return
		if (displayed.current?.clientRevision !== project.revision) {
			setLocationStatus('等待预览更新后定位')
			return
		}
		if (!viewport.current?.clientWidth || !viewport.current.clientHeight) return
		if (!Object.hasOwn(project.snapshot().files, selected.path)) return
		view.current?.refresh()
		const projection = project.open(selected.path)
		const point = findTypstSourcePosition({ projection, position: selected.position })
		let found = point ? view.current?.revealSource(point) : false
		// A caret at the exclusive end of a paragraph belongs to its preceding glyph.
		const instance = selected.editor
		if (
			!found &&
			instance &&
			!instance.isDestroyed &&
			selected.position <= instance.state.doc.content.size
		) {
			const at = instance.state.doc.resolve(selected.position)
			if (instance.state.selection.empty && at.parent.isTextblock && at.nodeBefore?.isText) {
				const previous = findTypstSourcePosition({
					projection,
					position: selected.position - 1,
				})
				found = previous ? view.current?.revealSource(previous) : false
			}
		}
		selected.explicit = false
		setLocationStatus(found ? '已定位光标处 · 点击纸面可返回编辑' : '此处暂不支持预览定位')
	}
	useEffect(() => {
		sourceSelection.current = selection ? { ...selection } : undefined
		revealSelection()
	}, [
		selection?.serial,
		selection?.path,
		selection?.position,
		selection?.explicit,
		selection?.editor,
	])
	useEffect(revealSelection, [displayedRevision, following, revision])
	useEffect(() => {
		// A retained routed tab can receive selections while its viewport is hidden.
		const observer = new ResizeObserver(revealSelection)
		if (viewport.current) observer.observe(viewport.current)
		return () => observer.disconnect()
	}, [project])

	async function pdf() {
		if (!compiled || displayed.current?.clientRevision !== project.revision) return
		if (latest.current.hasPending) {
			latest.current.onIssue('有尚未应用的源码或参数，请先应用或取消。')
			return
		}
		try {
			const response = await post('/pdf', { revision: compiled.preview.revision })
			if (!response.ok) {
				latest.current.onIssue(JSON.stringify(await response.json()))
				return
			}
			const url = URL.createObjectURL(await response.blob())
			const link = document.createElement('a')
			link.href = url
			link.download = application ? 'application.pdf' : 'report.pdf'
			link.click()
			setTimeout(() => URL.revokeObjectURL(url), 1000)
		} catch (error) {
			latest.current.onIssue(String(error))
		}
	}

	return (
		<section className="preview-pane" aria-label="文档预览" data-folder={folder}>
			<div className="preview-heading">
				<h2>预览</h2>
				<span title="main.typ">main.typ</span>
			</div>
			<div className="preview-actions">
				<button
					type="button"
					aria-expanded={outline}
					aria-controls={`preview-outline-${folder}`}
					onClick={() => setOutline(!outline)}
				>
					目录
				</button>
				<PreviewPageControl state={viewState} view={view.current} />
				{!application && (
					<button
						type="button"
						className="preview-follow"
						aria-label="跟随光标"
						aria-pressed={following}
						title="随编辑器中的光标定位预览"
						onClick={() => setFollowing(!following)}
					>
						跟随光标
					</button>
				)}
				<select
					aria-label="缩放"
					value={String(viewState.zoom)}
					onChange={(event) =>
						view.current?.setZoom(
							event.currentTarget.value === 'fit-width'
								? 'fit-width'
								: Number(event.currentTarget.value),
						)
					}
				>
					<option value="fit-width">适合宽度</option>
					<option value="1">100%</option>
					<option value="1.5">150%</option>
				</select>
				<button
					type="button"
					disabled={!compiled || hasPending || !previewCurrent}
					onClick={() => void pdf()}
				>
					下载 PDF
				</button>
			</div>
			<output data-testid="revision" className="workspace-revision">
				<span className="sync-indicator" data-state={busy ? 'busy' : failure ? 'error' : 'ready'} />
				{busy ? '更新预览中' : failure ? '编译失败' : previewCurrent ? '预览已同步' : '待编译'}
				{` · 源码 ${revision}`}
				{displayedRevision !== undefined && !previewCurrent
					? ` · 旧预览（源码 ${displayedRevision}）`
					: ''}
				{hasPending && <span className="draft-status">有更改尚未应用</span>}
			</output>
			{compiled?.clientRevision === revision && compiled.diagnostics?.length > 0 && (
				<details>
					<summary>编译诊断（{compiled.diagnostics.length}）</summary>
					{compiled.diagnostics.map((item, index) => (
						<p key={index}>
							{item.path}: {item.severity}: {item.message}
						</p>
					))}
				</details>
			)}
			{failure && (
				<div role="alert" className="source-failure">
					{failure.code}: {failure.message}
					{failure.diagnostics.map((diagnostic, index) => (
						<button
							type="button"
							key={index}
							onClick={() => {
								const point = diagnosticPosition(diagnostic)
								if (point) latest.current.onNavigate(point)
							}}
						>
							{diagnostic.path}: {diagnostic.message}
						</button>
					))}
				</div>
			)}
			<p className="preview-location-status" role="status">
				{application
					? '填写后更新预览 · 点击纸面可查看对应源码'
					: following
						? locationStatus
						: '自动跟随已关闭 · 点击纸面可返回编辑'}
			</p>
			<PreviewOutline
				id={`preview-outline-${folder}`}
				state={viewState}
				view={view.current}
				open={outline}
				onClose={() => setOutline(false)}
			/>
			<div className="preview-scroll" ref={viewport}>
				<div ref={container} />
			</div>
		</section>
	)
}
