import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { createTypstRenderer } from '@myriaddreamin/typst.ts/renderer'
import wasmUrl from '@myriaddreamin/typst-ts-renderer/wasm?url'
import {
	TypstPreviewView,
	type SourcePosition,
	type TypstPreview,
	type TypstPreviewState,
} from '@pluxel/plugin-typst/browser'
import {
	applyTypstCandidate,
	findTypstGeneratedPosition,
	findTypstRegionPosition,
	prepareTypstCandidate,
	parseTypstMarkdown,
	parseTypstClipboard,
	validateTypstDraft,
	type JSONContent,
	type TypstDocumentDraft,
	type TypstGeneratedMapping,
	type TypstMarkdownCandidate,
	type TypstPreparedCandidate,
} from '@pluxel/plugin-typst/tiptap'
import {
	TypstEditorToolbar,
	TypstFieldPicker,
	TypstBlockPicker,
	TypstRegionEditor,
} from '@pluxel/plugin-typst/tiptap/react'
import type { Editor } from '@tiptap/core'
import { TextSelection, NodeSelection } from '@tiptap/pm/state'
import { fontFamilies, initialDraft, initialSource } from './editor-config.mjs'
import { examples, getExample } from './report-example.mjs'
import '@pluxel/plugin-typst/tiptap/style.css'
import './style.css'

const workspaceTabs = [
	{ id: 'editor', label: '正文' },
	{ id: 'data', label: '数据' },
	{ id: 'template', label: '模板' },
	{ id: 'candidate', label: 'AI 候选' },
] as const
type WorkspaceTab = (typeof workspaceTabs)[number]['id']

interface Snapshot {
	revision: number
	draft: TypstDocumentDraft
	source: string
}
interface Compiled {
	clientRevision: number
	preview: TypstPreview
	mapping: TypstGeneratedMapping[]
}

function App() {
	const [draft, setDraft] = useState<TypstDocumentDraft>(
		structuredClone(initialDraft) as TypstDocumentDraft,
	)
	const [source, setSource] = useState(initialSource)
	const example = getExample(draft.templateId)
	const { config, parseData } = example
	const [dataText, setDataText] = useState(JSON.stringify(initialDraft.data, null, 2))
	const [workspaceTab, setWorkspaceTab] = useState<WorkspaceTab>('editor')
	const exampleLoad = useRef(0)
	const [revision, setRevision] = useState(1)
	const [epoch, setEpoch] = useState(0)
	const [region, setRegion] = useState('body')
	const [compiled, setCompiled] = useState<Compiled>()
	const [viewState, setViewState] = useState<TypstPreviewState>({
		pageCount: 0,
		currentPage: 1,
		currentHeading: -1,
	})
	const [candidateScope, setCandidateScope] = useState<'region' | 'blocks'>('region')
	const [candidate, setCandidate] = useState<TypstMarkdownCandidate>()
	const [candidateText, setCandidateText] = useState(
		'## Accepted candidate\n\nPrepared for <data-field path=\'["customer","name"]\'></data-field>.',
	)
	const [message, setMessage] = useState('')
	const [permission, setPermission] = useState(true)
	const [editable, setEditable] = useState(true)
	const [importResult, setImportResult] = useState('')
	const [error, setError] = useState('')
	const [busy, setBusy] = useState(false)
	const [zoom, setZoom] = useState(1)
	const [navigation, setNavigation] = useState('')
	const container = useRef<HTMLDivElement>(null)
	const viewport = useRef<HTMLDivElement>(null)
	const sourceEditor = useRef<HTMLTextAreaElement>(null)
	const view = useRef<TypstPreviewView | undefined>(undefined)
	const editors = useRef(new Map<string, Editor>())
	const current = useRef<Snapshot>({ revision, draft, source })
	current.current = { revision, draft, source }
	const displayed = useRef<Compiled | undefined>(undefined)
	const pending = useRef<Snapshot | undefined>(undefined)
	const running = useRef(false)
	const alive = useRef(true)
	const navigationSerial = useRef(0)
	const pointer = useRef<{ x: number; y: number } | null>(null)
	const [clientId] = useState(() => crypto.randomUUID())
	const parsedData = parseData(draft.data)

	function change(update: (previous: TypstDocumentDraft) => TypstDocumentDraft) {
		setDraft(update)
		setRevision((value) => value + 1)
	}
	async function loadExample(id: string) {
		const serial = ++exampleLoad.current
		try {
			const next = getExample(id)
			const response = next.templateUrl ? await fetch(next.templateUrl) : undefined
			if (response && !response.ok) throw new Error('示例模板读取失败')
			const template = response ? await response.text() : next.source!
			if (serial !== exampleLoad.current) return
			setDraft(structuredClone(next.draft))
			setDataText(JSON.stringify(next.draft.data, null, 2))
			setSource(template)
			setRegion('body')
			setWorkspaceTab('editor')
			setCandidate(undefined)
			setEpoch((value) => value + 1)
			setRevision((value) => value + 1)
			setError('')
			setMessage(`已载入${next.label}`)
		} catch (cause) {
			setError(String(cause))
		}
	}
	function applyData() {
		try {
			const raw: unknown = JSON.parse(dataText)
			parseData(raw)
			const checked = validateTypstDraft({
				draft: { ...draft, data: raw },
				config,
				templateId: example.id,
				templateRevision: example.draft.templateRevision,
			})
			if (!checked.ok) throw new Error(JSON.stringify(checked.issues))
			change((previous) => ({ ...previous, data: checked.value.data }))
			setError('')
			setMessage('已应用外部数据，正文与撤销历史保留')
		} catch (cause) {
			setError(String(cause))
		}
	}

	useEffect(() => {
		alive.current = true
		return () => {
			alive.current = false
			++navigationSerial.current
			void view.current?.dispose()
		}
	}, [])

	useEffect(() => {
		const close = (event: PageTransitionEvent) => {
			if (event.persisted) return
			void fetch('/session/close', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'X-Typst-Client': clientId },
				body: '{}',
				keepalive: true,
			}).catch((cause) => console.warn('Could not release the preview session', cause))
		}
		window.addEventListener('pagehide', close)
		return () => window.removeEventListener('pagehide', close)
	}, [clientId])

	useEffect(() => {
		pending.current = current.current
		if (running.current) return
		running.current = true
		void (async () => {
			setBusy(true)
			try {
				while (pending.current && alive.current) {
					const snapshot = pending.current
					pending.current = undefined
					try {
						const response = await fetch('/compile', {
							method: 'POST',
							headers: { 'Content-Type': 'application/json', 'X-Typst-Client': clientId },
							body: JSON.stringify(snapshot),
						})
						const value = await response.json()
						if (!response.ok) throw new Error(value.message)
						if (!alive.current || snapshot.revision !== current.current.revision) continue
						setCompiled({
							...value,
							preview: { ...value.preview, data: new Uint8Array(value.preview.data) },
						})
						setError('')
					} catch (cause) {
						if (alive.current && snapshot.revision === current.current.revision)
							setError(String(cause))
					}
				}
			} finally {
				running.current = false
				if (alive.current) setBusy(false)
			}
		})()
	}, [revision])

	useEffect(() => {
		if (!compiled || !container.current || !viewport.current) return
		let canceled = false
		void (async () => {
			if (!view.current) {
				const renderer = createTypstRenderer()
				await renderer.init({ getModule: () => wasmUrl })
				if (canceled || !alive.current || !container.current || !viewport.current) return
				view.current = new TypstPreviewView({
					container: container.current,
					scrollContainer: viewport.current,
					renderer,
					sessionId: compiled.preview.sessionId,
					onStateChange: setViewState,
					isNavigationCurrent: () => displayed.current?.clientRevision === current.current.revision,
					onNavigate: ({ point }) => {
						const snapshot = displayed.current
						if (!snapshot || snapshot.clientRevision !== current.current.revision) return
						const serial = ++navigationSerial.current
						const target = findTypstRegionPosition({
							mapping: snapshot.mapping,
							position: point,
							snapshotRevision: snapshot.clientRevision,
						})
						if (target) {
							setWorkspaceTab('editor')
							setRegion(target.regionId)
							requestAnimationFrame(() => {
								if (
									serial !== navigationSerial.current ||
									snapshot.clientRevision !== current.current.revision
								)
									return
								const editor = editors.current.get(target.regionId)
								if (!editor) return
								const from = Math.min(Math.max(0, target.from), editor.state.doc.content.size)
								editor.view.dispatch(
									editor.state.tr
										.setSelection(
											editor.state.doc.nodeAt(from)?.isAtom &&
												!editor.state.doc.nodeAt(from)?.isText
												? NodeSelection.create(editor.state.doc, from)
												: TextSelection.near(editor.state.doc.resolve(from)),
										)
										.setMeta('typst-navigation', target.source ?? true)
										.scrollIntoView(),
								)
								editor.view.focus()
								setNavigation(`region:${target.regionId}:${target.from}`)
							})
						} else if (point.path === 'main.typ' && sourceEditor.current) {
							const lines = current.current.source.split('\n')
							const offset =
								lines.slice(0, point.line - 1).reduce((sum, line) => sum + line.length + 1, 0) +
								point.column -
								1
							setWorkspaceTab('template')
							requestAnimationFrame(() => {
								if (
									serial !== navigationSerial.current ||
									snapshot.clientRevision !== current.current.revision
								)
									return
								sourceEditor.current?.focus()
								sourceEditor.current?.setSelectionRange(offset, offset)
								setNavigation(`source:${point.line}:${point.column}`)
							})
						}
					},
				})
			}
			if (canceled) return
			if (await view.current.show(compiled.preview)) displayed.current = compiled
		})().catch((cause) => {
			if (!canceled) setError(String(cause))
		})
		return () => {
			canceled = true
		}
	}, [compiled])

	function revealSource(position: SourcePosition) {
		if (
			displayed.current?.clientRevision === current.current.revision &&
			view.current?.revealSource(position)
		)
			setNavigation(`preview:${position.path}:${position.line}`)
	}

	function revealRegion(regionId: string, position: number) {
		const snapshot = displayed.current
		const editor = editors.current.get(regionId)
		if (!editor || !snapshot || snapshot.clientRevision !== current.current.revision) return
		const generated = findTypstGeneratedPosition({
			mapping: snapshot.mapping,
			navigation: snapshot.preview.navigation,
			regionId,
			position,
			snapshotRevision: snapshot.clientRevision,
		})
		if (generated) revealSource(generated)
	}

	function save() {
		const checked = validateTypstDraft({
			draft,
			config,
			templateId: example.id,
			templateRevision: example.draft.templateRevision,
		})
		if (!checked.ok) {
			setError(JSON.stringify(checked.issues))
			return
		}
		localStorage.setItem('typst-consumer-draft', JSON.stringify({ draft: checked.value, source }))
		setMessage('已保存原始输入与区域 JSON')
	}

	function reopen() {
		try {
			const stored = localStorage.getItem('typst-consumer-draft')
			if (!stored) return
			const saved = JSON.parse(stored)
			const savedExample = getExample(saved.draft?.templateId)
			if (typeof saved.source !== 'string') throw new Error('保存的模板必须是字符串')
			savedExample.parseData(saved.draft.data)
			const checked = validateTypstDraft({
				draft: saved.draft,
				config: savedExample.config,
				templateId: savedExample.id,
				templateRevision: savedExample.draft.templateRevision,
			})
			if (!checked.ok) {
				setError(JSON.stringify(checked.issues))
				return
			}
			setDraft(checked.value)
			setSource(saved.source)
			setDataText(JSON.stringify(checked.value.data, null, 2))
			setRegion('body')
			setWorkspaceTab('editor')
			setCandidate(undefined)
			setError('')
			setEpoch((value) => value + 1)
			setRevision((value) => value + 1)
			setMessage('已重开保存的草稿')
		} catch (cause) {
			setError(String(cause))
		}
	}

	function acceptCandidate() {
		const editor = editors.current.get(region)
		if (!candidate || !editor) return
		const prepared = prepareTypstCandidate({
			candidate,
			currentRevision: current.current.revision,
			document: editor.getJSON(),
			config,
			data: parseData(current.current.draft.data),
			canEdit: (id) => permission && id === region,
		})
		if (!prepared.ok) {
			setError(JSON.stringify(prepared.issues))
			return
		}
		const result = applyTypstCandidate({
			candidate: prepared.value as TypstPreparedCandidate,
			editor,
			regionId: region,
			currentRevision: () => current.current.revision,
			config,
			data: () => parseData(current.current.draft.data),
			canEdit: (id) => permission && id === region,
		})
		if (!result.ok) setError(JSON.stringify(result.issues))
		else {
			setError('')
			setMessage('候选已接纳，可一次撤销')
			setWorkspaceTab('editor')
		}
	}

	return (
		<main>
			<header>
				<div>
					<p className="eyebrow">PLUXEL / TYPST</p>
					<h1>编辑与排版体验</h1>
				</div>
				<span>点击正文或预览文字，双向定位 · 表格右键打开操作</span>
			</header>
			<div className="host-actions">
				<label>
					示例{' '}
					<select
						aria-label="示例"
						value={example.id}
						onChange={(event) => void loadExample(event.currentTarget.value)}
					>
						{examples.map((item) => (
							<option key={item.id} value={item.id}>
								{item.label}
							</option>
						))}
					</select>
				</label>
				{example.id === 'consumer-report' && (
					<label>
						客户{' '}
						<select
							aria-label="客户"
							value={(draft.data.customer as { name: string }).name}
							onChange={(event) =>
								change((previous) => ({
									...previous,
									data: { customer: { name: event.target.value } },
								}))
							}
						>
							<option>Acme</option>
							<option>Beta</option>
						</select>
					</label>
				)}
				<label>
					<input
						type="checkbox"
						checked={!editable}
						onChange={(event) => setEditable(!event.currentTarget.checked)}
					/>
					区域只读
				</label>
				<button type="button" onClick={save}>
					保存
				</button>
				<button type="button" onClick={reopen}>
					重开
				</button>
				<button
					type="button"
					disabled={!compiled || compiled.clientRevision !== revision || busy}
					onClick={async () => {
						try {
							const response = await fetch('/pdf', {
								method: 'POST',
								headers: { 'Content-Type': 'application/json', 'X-Typst-Client': clientId },
								body: JSON.stringify({ revision: compiled!.preview.revision }),
							})
							if (!response.ok) {
								const failure = await response.json()
								throw new Error(failure.message)
							}
							const blob = await response.blob()
							const url = URL.createObjectURL(blob)
							const anchor = document.createElement('a')
							anchor.href = url
							anchor.download = 'consumer-report.pdf'
							anchor.click()
							URL.revokeObjectURL(url)
						} catch (cause) {
							setError(String(cause))
						}
					}}
				>
					导出当前 PDF
				</button>
				<output data-testid="revision">
					草稿 {revision} / 预览 {compiled?.clientRevision ?? '—'}
					{busy ? ' · 编译中' : compiled?.clientRevision !== revision ? ' · 过期' : ' · 当前'}
				</output>
			</div>
			{error && <pre role="alert">{error}</pre>}
			<div className="columns">
				<section className="editing">
					<div role="tablist" aria-label="编辑工作区" className="workspace-tabs">
						{workspaceTabs.map((tab, index) => (
							<button
								type="button"
								role="tab"
								key={tab.id}
								id={`tab-${tab.id}`}
								aria-controls={`panel-${tab.id}`}
								aria-selected={workspaceTab === tab.id}
								tabIndex={workspaceTab === tab.id ? 0 : -1}
								onClick={() => setWorkspaceTab(tab.id)}
								onKeyDown={(event) => {
									const next =
										event.key === 'ArrowRight'
											? (index + 1) % workspaceTabs.length
											: event.key === 'ArrowLeft'
												? (index + workspaceTabs.length - 1) % workspaceTabs.length
												: event.key === 'Home'
													? 0
													: event.key === 'End'
														? workspaceTabs.length - 1
														: undefined
									if (next === undefined) return
									event.preventDefault()
									setWorkspaceTab(workspaceTabs[next]!.id)
									document.getElementById(`tab-${workspaceTabs[next]!.id}`)?.focus()
								}}
							>
								{tab.label}
							</button>
						))}
					</div>
					<div
						id="panel-editor"
						role="tabpanel"
						aria-labelledby="tab-editor"
						hidden={workspaceTab !== 'editor'}
						className="workspace-panel editor-panel"
					>
						<nav aria-label="正文区域">
							{config.regions.map((item) => (
								<button
									type="button"
									key={item.id}
									aria-pressed={region === item.id}
									onClick={() => setRegion(item.id)}
								>
									{item.label}
								</button>
							))}
						</nav>
						{config.regions.map((item) => (
							<div
								key={`${epoch}:${item.id}`}
								data-testid={`region-${item.id}`}
								className="region-panel"
								hidden={region !== item.id}
								onPointerDown={(event) => {
									pointer.current = { x: event.clientX, y: event.clientY }
								}}
								onPointerUp={(event) => {
									const start = pointer.current
									pointer.current = null
									if (
										!start ||
										event.button !== 0 ||
										event.ctrlKey ||
										event.metaKey ||
										event.altKey ||
										event.shiftKey ||
										Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4 ||
										(event.target as HTMLElement).closest('.typst-content-block') ||
										!(event.target as HTMLElement).closest('.tiptap') ||
										!window.getSelection()?.isCollapsed
									)
										return
									const editor = editors.current.get(item.id)
									const selection = editor?.view.dom.ownerDocument.getSelection()
									if (
										!editor ||
										!selection?.anchorNode ||
										!editor.view.dom.contains(selection.anchorNode)
									)
										return
									// DOM selection precedes ProseMirror's selectionchange transaction.
									revealRegion(
										item.id,
										editor.view.posAtDOM(selection.anchorNode, selection.anchorOffset),
									)
								}}
							>
								<TypstRegionEditor
									regionId={item.id}
									onReveal={(position) => revealRegion(item.id, position)}
									content={draft.regions[item.id]!}
									config={config}
									data={parsedData}
									editable={editable}
									onValidationError={(issues) => setError(JSON.stringify(issues))}
									onEditor={(editor) => {
										if (editor) editors.current.set(item.id, editor)
										else editors.current.delete(item.id)
									}}
									onChange={(content: JSONContent) =>
										change((previous) => ({
											...previous,
											regions: { ...previous.regions, [item.id]: content },
										}))
									}
									onSelection={(position) => {
										const element = editors.current.get(item.id)?.view.dom
										if (element) element.dataset.consumerSelection = String(position)
									}}
								>
									{(editor) => (
										<TypstEditorToolbar editor={editor} fontFamilies={fontFamilies}>
											<TypstFieldPicker editor={editor} fields={config.fields} />
											<TypstBlockPicker editor={editor} />
											<button
												type="button"
												onMouseDown={(event) => event.preventDefault()}
												onClick={() =>
													editor
														.chain()
														.focus()
														.insertContent({
															type: 'notice',
															attrs: { tone: 'info' },
															content: [
																{
																	type: 'paragraph',
																	content: [{ type: 'text', text: 'Consumer-owned notice' }],
																},
															],
														})
														.run()
												}
											>
												添加提示块
											</button>
										</TypstEditorToolbar>
									)}
								</TypstRegionEditor>
							</div>
						))}
					</div>
					<div
						id="panel-data"
						role="tabpanel"
						aria-labelledby="tab-data"
						hidden={workspaceTab !== 'data'}
						className="workspace-panel input-panel"
					>
						<div className="panel-intro">
							<h2>业务数据</h2>
							<p>修改图表和绑定字段的数据；应用后保留正文与撤销历史。</p>
						</div>
						<textarea
							aria-label="外部 JSON 数据"
							value={dataText}
							onChange={(event) => setDataText(event.currentTarget.value)}
						/>
						<input
							aria-label="导入 JSON 文件"
							type="file"
							accept=".json,application/json"
							onChange={async (event) => {
								const file = event.currentTarget.files?.[0]
								if (!file) return
								try {
									if (file.size > 1024 * 1024) throw new Error('JSON 文件超过 1 MiB')
									setDataText(await file.text())
								} catch (cause) {
									setError(String(cause))
								}
							}}
						/>
						<button type="button" onClick={applyData}>
							应用 JSON 数据
						</button>
						<a href="/examples/operations-report.json" download>
							下载图表报告 JSON
						</a>
					</div>
					<div
						id="panel-template"
						role="tabpanel"
						aria-labelledby="tab-template"
						hidden={workspaceTab !== 'template'}
						className="workspace-panel input-panel"
					>
						<div className="panel-intro">
							<h2>排版模板</h2>
							<p>源码实时编译。点击预览中的固定文字，会自动定位到这里。</p>
						</div>
						<input
							aria-label="导入 Typst 模板文件"
							type="file"
							accept=".typ,text/plain"
							onChange={async (event) => {
								const file = event.currentTarget.files?.[0]
								if (!file) return
								try {
									if (file.size > 1024 * 1024) throw new Error('模板文件超过 1 MiB')
									setSource(await file.text())
									setRevision((value) => value + 1)
								} catch (cause) {
									setError(String(cause))
								}
							}}
						/>
						<textarea
							ref={sourceEditor}
							aria-label="Typst 源码"
							className="source"
							value={source}
							onChange={(event) => {
								setSource(event.target.value)
								setRevision((value) => value + 1)
							}}
							onClick={(event) => {
								const before = source.slice(0, event.currentTarget.selectionStart)
								const lines = before.split('\n')
								revealSource({
									path: 'main.typ',
									line: lines.length,
									column: lines.at(-1)!.length + 1,
								})
							}}
						/>
						<div className="panel-actions">
							<a href="/examples/operations-report.typ" download>
								下载 Typst 模板
							</a>
							<a href="/examples/operations-cover.svg" download>
								查看配套插图
							</a>
						</div>
					</div>
					<div
						id="panel-candidate"
						role="tabpanel"
						aria-labelledby="tab-candidate"
						hidden={workspaceTab !== 'candidate'}
						className="workspace-panel input-panel"
					>
						<div className="panel-intro">
							<h2>AI / Markdown 候选</h2>
							<p>粘贴外部生成的 Markdown，检查后接纳到指定区域。接纳可一次撤销。</p>
						</div>
						<label>
							目标区域{' '}
							<select
								aria-label="候选目标区域"
								value={region}
								onChange={(event) => setRegion(event.currentTarget.value)}
							>
								{config.regions.map((item) => (
									<option key={item.id} value={item.id}>
										{item.label}
									</option>
								))}
							</select>
						</label>
						<label>
							修改范围{' '}
							<select
								aria-label="候选修改范围"
								value={candidateScope}
								onChange={(event) =>
									setCandidateScope(event.currentTarget.value as 'region' | 'blocks')
								}
							>
								<option value="region">整个区域</option>
								<option value="blocks">当前选中块</option>
							</select>
						</label>
						<p className="candidate-hint">
							只改文字时，先在正文中放置光标或选中文字，再选择“当前选中块”。其他图表和表格会完整保留。
						</p>
						<textarea
							aria-label="候选 Markdown"
							value={candidateText}
							onChange={(event) => setCandidateText(event.target.value)}
						/>
						<div className="panel-actions">
							<label>
								<input
									type="checkbox"
									checked={permission}
									onChange={(event) => setPermission(event.target.checked)}
								/>
								允许接纳候选
							</label>
							<button
								type="button"
								onClick={() => {
									const editor = editors.current.get(region)
									if (!editor) return
									const { selection, doc } = editor.state
									let from = -1,
										to = -1
									doc.forEach((node, offset) => {
										if (
											selection.from < offset + node.nodeSize &&
											(selection.empty ? selection.from >= offset : selection.to > offset)
										) {
											if (from === -1) from = offset
											to = offset + node.nodeSize
										}
									})
									setCandidate({
										...(candidateScope === 'blocks' ? { range: { from, to } } : {}),
										regionId: region,
										baseRevision: revision,
										markdown: candidateText,
									})
									setMessage(`候选基于草稿 ${revision}`)
									setError('')
								}}
							>
								暂存候选
							</button>
							<button type="button" onClick={acceptCandidate}>
								接纳候选
							</button>
							<button
								type="button"
								onClick={() =>
									setImportResult(
										JSON.stringify(
											parseTypstMarkdown({
												markdown: candidateText,
												regionId: region,
												config,
												data: parsedData,
											}),
										),
									)
								}
							>
								检查 Markdown
							</button>
							<button
								type="button"
								onClick={() =>
									setImportResult(
										JSON.stringify(
											parseTypstClipboard({
												html: candidateText,
												text: '',
												regionId: region,
												config,
												data: parsedData,
											}),
										),
									)
								}
							>
								检查 HTML
							</button>
						</div>
						{importResult && <pre data-testid="import-result">{importResult}</pre>}
					</div>
				</section>
				<section className="preview-pane">
					<h2>排版预览</h2>
					<div className="preview-actions">
						<button
							type="button"
							onClick={() => view.current?.jumpToPage(viewState.currentPage - 1)}
						>
							上一页
						</button>
						<output data-testid="page">
							{viewState.currentPage} / {viewState.pageCount}
						</output>
						<button
							type="button"
							onClick={() => view.current?.jumpToPage(viewState.currentPage + 1)}
						>
							下一页
						</button>
						<label>
							缩放{' '}
							<select
								aria-label="缩放"
								value={zoom}
								onChange={(event) => setZoom(Number(event.target.value))}
							>
								<option value={1}>100%</option>
								<option value={1.5}>150%</option>
							</select>
						</label>
					</div>
					<nav aria-label="目录">
						{viewState.preview?.navigation.outline.map((item, index) => (
							<button
								type="button"
								key={index}
								aria-current={viewState.currentHeading === index ? 'location' : undefined}
								onClick={() => view.current?.jumpToPosition(item)}
							>
								{item.title}
							</button>
						))}
					</nav>
					<div className="preview-scroll" ref={viewport}>
						<div ref={container} className="typst-pages" style={{ width: `${zoom * 100}%` }} />
					</div>
				</section>
			</div>
			<footer className="workspace-status">
				<span role="status">{message || '切换工作标签保留编辑内容；切换示例前请先保存。'}</span>
				<output data-testid="navigation">{navigation}</output>
			</footer>
		</main>
	)
}

createRoot(document.getElementById('root')!).render(<App />)
