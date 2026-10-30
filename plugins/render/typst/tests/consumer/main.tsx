import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { createTypstRenderer } from '@myriaddreamin/typst.ts/renderer'
import wasmUrl from '@myriaddreamin/typst-ts-renderer/wasm?url'
import parserWasm from '@pluxel/plugin-typst/source/parser.wasm?url'
import {
	TypstPreviewView,
	type SourcePosition,
	type TypstPreview,
	type TypstPreviewState,
	type TypstDiagnostic,
} from '@pluxel/plugin-typst/browser'
import {
	createTypstSourceProject,
	findTypstEditorPosition,
	findTypstSourcePosition,
	type TypstSourceProject,
	type TypstSourceComponent,
} from '@pluxel/plugin-typst/source/browser'
import { TypstSourceEditor } from '@pluxel/plugin-typst/tiptap/react'
import type { Editor } from '@tiptap/core'
import { PreviewPageControl, PreviewOutline } from './preview-controls'
import { diagnosticPosition, type ConsumerFailure } from './compile-contract'
import '@pluxel/plugin-typst/tiptap/style.css'
import './style.css'

const storageKey = 'typst-source-project-v1'
const encoder = new TextEncoder()
const fontFamilies = ['Noto Serif CJK SC', 'Liberation Serif']
interface Compiled {
	clientRevision: number
	preview: TypstPreview
	diagnostics: readonly TypstDiagnostic[]
}

function App({
	project,
	initialFiles,
}: {
	project: TypstSourceProject
	initialFiles: Record<string, string>
}) {
	const revision = useSyncExternalStore(project.subscribe, () => project.revision)
	const [path, setPath] = useState('sections/analysis.typ')
	const [mode, setMode] = useState<'editor' | 'source'>('editor')
	const [sourceDraft, setSourceDraft] = useState(() => {
		const value = project.snapshot().files[path]
		const text = typeof value === 'string' ? value : new TextDecoder().decode(value)
		return { path, text, base: text, revision }
	})
	const [compiled, setCompiled] = useState<Compiled>()
	const [failure, setFailure] = useState<ConsumerFailure>()
	const [message, setMessage] = useState('')
	const [busy, setBusy] = useState(false)
	const [unapplied, setUnapplied] = useState(false)
	const [outline, setOutline] = useState(false)
	const [displayedRevision, setDisplayedRevision] = useState<number>()
	const [viewState, setViewState] = useState<TypstPreviewState>({
		pageCount: 0,
		currentPage: 1,
		currentHeading: -1,
		zoom: 'fit-width',
	})
	const clientId = useRef(crypto.randomUUID())
	const editor = useRef<Editor | null>(null)
	const container = useRef<HTMLDivElement>(null)
	const viewport = useRef<HTMLDivElement>(null)
	const view = useRef<TypstPreviewView | undefined>(undefined)
	const displayed = useRef<Compiled | undefined>(undefined)
	const currentPath = useRef(path)
	currentPath.current = path
	const pendingSelection = useRef<number | undefined>(undefined)
	const files = project.snapshot().files
	const text = (name: string) => {
		const value = project.snapshot().files[name]
		return typeof value === 'string' ? value : new TextDecoder().decode(value)
	}
	const post = (url: string, body: unknown, signal?: AbortSignal) =>
		fetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'X-Typst-Client': clientId.current },
			body: JSON.stringify(body),
			signal,
		})

	useEffect(() => {
		const check = () => setUnapplied(Boolean(document.querySelector('[data-typst-unapplied]')))
		const observer = new MutationObserver(check)
		observer.observe(document.getElementById('root')!, {
			subtree: true,
			childList: true,
			attributes: true,
			attributeFilter: ['data-typst-unapplied'],
		})
		check()
		return () => observer.disconnect()
	}, [])
	const hasPending = unapplied || sourceDraft.text !== sourceDraft.base
	const mayReplace = () => {
		if (hasPending) {
			setMessage('有尚未应用的源码或参数，请先应用或取消。')
			return false
		}
		return true
	}
	const mayReplaceRef = useRef(mayReplace)
	mayReplaceRef.current = mayReplace
	function save() {
		if (!mayReplace()) return
		try {
			localStorage.setItem(storageKey, JSON.stringify(project.snapshot().files))
			setMessage(`已保存源码修订 ${project.revision}`)
		} catch (error) {
			setMessage(`保存失败，当前源码仍保留在内存：${String(error)}`)
		}
	}
	useEffect(() => {
		const value = text(path)
		setSourceDraft((draft) =>
			draft.path !== path || draft.text === draft.base
				? { path, text: value, base: value, revision }
				: draft,
		)
	}, [path, revision])
	useEffect(() => {
		const controller = new AbortController()
		const timer = setTimeout(() => {
			const snapshot = project.snapshot()
			setBusy(true)
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
					if (!controller.signal.aborted) setMessage(String(error))
				})
				.finally(() => {
					if (!controller.signal.aborted) setBusy(false)
				})
		}, 350)
		return () => {
			clearTimeout(timer)
			controller.abort()
		}
	}, [revision])

	function navigate(position: SourcePosition) {
		if (displayed.current?.clientRevision !== project.revision) return
		if (!mayReplaceRef.current()) return
		const file = position.path.replace(/^\//, '')
		if (!Object.hasOwn(project.snapshot().files, file)) return
		if (file.endsWith('.typ')) {
			const at = findTypstEditorPosition({
				projection: project.open(file),
				sourcePosition: { ...position, path: file },
			})
			setMode('editor')
			if (file === currentPath.current && at !== undefined)
				editor.current?.commands.setTextSelection(at)
			else pendingSelection.current = at
		}
		setPath(file)
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
			if (!canceled) setMessage(String(error))
		})
		return () => {
			canceled = true
		}
	}, [compiled])
	useEffect(() => {
		const close = () => {
			void fetch('/session/close', {
				method: 'POST',
				keepalive: true,
				headers: { 'Content-Type': 'application/json', 'X-Typst-Client': clientId.current },
				body: '{}',
			})
		}
		window.addEventListener('pagehide', close)
		return () => {
			window.removeEventListener('pagehide', close)
			view.current?.dispose()
			close()
		}
	}, [])
	function applySource() {
		const result = project.apply({
			baseRevision: sourceDraft.revision,
			patches: [
				{
					path: sourceDraft.path,
					from: 0,
					to: encoder.encode(sourceDraft.base).length,
					text: sourceDraft.text,
				},
			],
		})
		if (!result.ok) {
			setMessage(result.issues.map((issue) => issue.message).join('\n'))
			return
		}
		setSourceDraft({ ...sourceDraft, base: sourceDraft.text, revision: project.revision })
		setMessage('源码已接纳；编译结果单独报告。')
	}
	function reveal(position: number) {
		if (displayed.current?.clientRevision !== project.revision) {
			setMessage('预览属于旧源码修订，编译成功后可定位。')
			return
		}
		const point = findTypstSourcePosition({ projection: project.open(path), position })
		if (point) view.current?.revealSource(point)
	}
	async function pdf() {
		if (!compiled || !mayReplace()) return
		const response = await post('/pdf', { revision: compiled.preview.revision })
		if (!response.ok) {
			setMessage(JSON.stringify(await response.json()))
			return
		}
		const url = URL.createObjectURL(await response.blob())
		const link = document.createElement('a')
		link.href = url
		link.download = 'report.pdf'
		link.click()
		setTimeout(() => URL.revokeObjectURL(url), 1000)
	}
	return (
		<main>
			<header className="workspace-header">
				<h1>Typst 源码报告</h1>
				<div className="host-actions">
					<button type="button" onClick={save}>
						保存项目
					</button>
					<button
						type="button"
						onClick={() => {
							if (!mayReplace()) return
							const saved = localStorage.getItem(storageKey)
							if (!saved) {
								setMessage('尚无已保存项目。')
								return
							}
							const result = project.replace({
								baseRevision: project.revision,
								files: JSON.parse(saved),
							})
							setMessage(
								result.ok
									? '已从保存的源码重新打开。'
									: result.issues.map((issue) => issue.message).join('\n'),
							)
						}}
					>
						重新打开
					</button>
					<button
						type="button"
						onClick={() => {
							if (!mayReplace()) return
							project.replace({ baseRevision: project.revision, files: initialFiles })
							setMessage('已重置为示例源码。')
						}}
					>
						重置示例
					</button>
					<button
						type="button"
						disabled={!compiled || hasPending || displayedRevision !== revision}
						onClick={() => void pdf()}
					>
						下载 PDF
					</button>
				</div>
				<output data-testid="revision">
					源码 {revision} ·{' '}
					{busy
						? '编译中'
						: failure
							? '编译失败'
							: compiled
								? `编译 ${compiled.preview.revision}`
								: '待编译'}
					{displayedRevision !== undefined && displayedRevision !== revision
						? ` · 旧预览（源码 ${displayedRevision}）`
						: ''}
				</output>
			</header>
			{hasPending && <p role="status">有尚未应用的源码或参数。</p>}
			{compiled?.clientRevision === revision && compiled.diagnostics?.length > 0 && (
				<details>
					<summary>编译诊断（{compiled.diagnostics.length}）</summary>
					{compiled.diagnostics.map((item, i) => (
						<p key={i}>
							{item.path}: {item.severity}: {item.message}
						</p>
					))}
				</details>
			)}
			{message && (
				<p role="status" className="source-status">
					{message}
				</p>
			)}
			{failure && (
				<div role="alert" className="source-failure">
					{failure.code}: {failure.message}
					{failure.diagnostics.map((diagnostic, index) => (
						<button
							type="button"
							key={index}
							onClick={() => {
								if (!mayReplace()) return
								const point = diagnosticPosition(diagnostic)
								if (point) {
									setPath(point.path)
									setMode('source')
								}
							}}
						>
							{diagnostic.path}: {diagnostic.message}
						</button>
					))}
				</div>
			)}
			<div className="columns">
				<section className="workspace-panel">
					<nav className="region-tabs">
						<select
							aria-label="源文件"
							value={path}
							onChange={(event) => {
								if (mayReplace()) setPath(event.currentTarget.value)
							}}
						>
							{Object.keys(files)
								.filter((file) => !file.startsWith('lib/'))
								.map((file) => (
									<option key={file}>{file}</option>
								))}
						</select>
						<button
							type="button"
							aria-pressed={mode === 'editor'}
							disabled={!path.endsWith('.typ')}
							onClick={() => {
								if (mayReplace()) setMode('editor')
							}}
						>
							结构化编辑
						</button>
						<button
							type="button"
							aria-pressed={mode === 'source'}
							onClick={() => {
								if (mayReplace()) setMode('source')
							}}
						>
							源码
						</button>
					</nav>
					{mode === 'editor' && path.endsWith('.typ') ? (
						<div className="editor-panel">
							<TypstSourceEditor
								project={project}
								path={path}
								fontFamilies={fontFamilies}
								onEditor={(instance) => {
									editor.current = instance
									if (instance && pendingSelection.current !== undefined) {
										instance.commands.setTextSelection(pendingSelection.current)
										pendingSelection.current = undefined
									}
								}}
								onReveal={reveal}
								onReference={(file, at) => {
									if (!mayReplace()) return
									if (file === path) editor.current?.commands.setTextSelection(at)
									else {
										pendingSelection.current = at
										setPath(file)
									}
									setMode('editor')
								}}
							/>
						</div>
					) : (
						<div className="input-panel">
							<label htmlFor="source-text">{path}</label>
							<textarea
								id="source-text"
								aria-label="文件源码"
								spellCheck={false}
								value={sourceDraft.text}
								onChange={(event) =>
									setSourceDraft({ ...sourceDraft, text: event.currentTarget.value })
								}
							/>
							<button type="button" onClick={applySource}>
								应用文件源码
							</button>
							<button
								type="button"
								onClick={() => {
									const value = text(path)
									setSourceDraft({ path, text: value, base: value, revision })
								}}
							>
								重新载入当前源码
							</button>
						</div>
					)}
				</section>
				<section className="preview-pane">
					<div className="preview-actions">
						<button type="button" onClick={() => setOutline(!outline)}>
							目录
						</button>
						<PreviewPageControl state={viewState} view={view.current} />
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
					</div>
					<PreviewOutline
						state={viewState}
						view={view.current}
						open={outline}
						onClose={() => setOutline(false)}
					/>
					<div className="preview-scroll" ref={viewport}>
						<div ref={container} />
					</div>
				</section>
			</div>
		</main>
	)
}

async function start() {
	const response = await fetch('/example')
	if (!response.ok) throw new Error(await response.text())
	const seed = (await response.json()) as {
		files: Record<string, string>
		components: TypstSourceComponent[]
	}
	const saved = localStorage.getItem(storageKey)
	const project = await createTypstSourceProject({
		files: saved ? JSON.parse(saved) : seed.files,
		components: seed.components,
		parserWasm,
	})
	createRoot(document.getElementById('root')!).render(
		<App project={project} initialFiles={seed.files} />,
	)
}
void start().catch((error) => {
	document.getElementById('root')!.textContent = String(error)
})
