import { useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
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
	applyTypstCandidate,
	exportTypstMarkdown,
	captureTypstCandidateTarget,
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
import { TypstRegionEditor, type TypstSlashCommand } from '@pluxel/plugin-typst/tiptap/react'
import type { Editor } from '@tiptap/core'
import { diagnosticPosition, sourceOffset, type ConsumerFailure } from './compile-contract'
import { ChannelParameters } from './channel-parameters'
import { TextSelection, NodeSelection } from '@tiptap/pm/state'
import { fontFamilies } from './editor-config.mjs'
import { examples, getExample, type ConsumerExample } from './report-example.mjs'
import '@pluxel/plugin-typst/tiptap/style.css'
import './style.css'

const consumerSlashCommands: readonly TypstSlashCommand[] = [
	{
		id: 'consumer-notice',
		title: '提示块',
		description: '添加报告核对提醒',
		keywords: ['notice', '提示', '提醒'],
		command: (chain) =>
			chain.insertContent({
				type: 'notice',
				attrs: { tone: 'info' },
				content: [
					{
						type: 'paragraph',
						content: [{ type: 'text', text: 'Consumer-owned notice' }],
					},
				],
			}),
	},
]

const workspaceTabs = [
	{ id: 'editor', label: '正文' },
	{ id: 'data', label: '数据' },
] as const
type WorkspaceTab = (typeof workspaceTabs)[number]['id']
const outputTabs = [
	{ id: 'preview', label: 'Typst 预览' },
	{ id: 'template', label: '原始 Typst' },
	{ id: 'candidate', label: 'Markdown' },
] as const
type OutputTab = (typeof outputTabs)[number]['id']

function TabBar<T extends string>({
	label,
	tabs,
	value,
	onChange,
}: {
	label: string
	tabs: readonly { id: T; label: string }[]
	value: T
	onChange: (value: T) => void
}) {
	return (
		<div role="tablist" aria-label={label} className="workspace-tabs">
			{tabs.map((tab, index) => (
				<button
					type="button"
					role="tab"
					key={tab.id}
					id={`tab-${tab.id}`}
					aria-controls={`panel-${tab.id}`}
					aria-selected={value === tab.id}
					tabIndex={value === tab.id ? 0 : -1}
					onClick={() => onChange(tab.id)}
					onKeyDown={(event) => {
						const next =
							event.key === 'ArrowRight'
								? (index + 1) % tabs.length
								: event.key === 'ArrowLeft'
									? (index + tabs.length - 1) % tabs.length
									: event.key === 'Home'
										? 0
										: event.key === 'End'
											? tabs.length - 1
											: undefined
						if (next === undefined) return
						event.preventDefault()
						onChange(tabs[next]!.id)
						document.getElementById(`tab-${tabs[next]!.id}`)?.focus()
					}}
				>
					{tab.label}
				</button>
			))}
		</div>
	)
}

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
interface Diagnosis {
	revision: number
	mapping: TypstGeneratedMapping[]
	diagnostics: readonly TypstDiagnostic[]
	failure?: ConsumerFailure
}

async function readExampleSource(example: ConsumerExample) {
	if (!example.templateUrl) return example.source!
	const response = await fetch(example.templateUrl)
	if (!response.ok) throw new Error('示例模板读取失败')
	return response.text()
}

function App({
	initialDraft,
	initialSource,
}: {
	initialDraft: TypstDocumentDraft
	initialSource: string
}) {
	const [draft, setDraft] = useState<TypstDocumentDraft>(
		structuredClone(initialDraft) as TypstDocumentDraft,
	)
	const [source, setSource] = useState(initialSource)
	const example = getExample(draft.templateId)
	const { config, parseData } = example
	const [dataText, setDataText] = useState(JSON.stringify(initialDraft.data, null, 2))
	const [workspaceTab, setWorkspaceTab] = useState<WorkspaceTab>('editor')
	const [outputTab, setOutputTab] = useState<OutputTab>('preview')
	const [markdownEditing, setMarkdownEditing] = useState(false)
	const [selectionVersion, setSelectionVersion] = useState(0)
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
	const [candidateTarget, setCandidateTarget] = useState<
		Omit<TypstMarkdownCandidate, 'markdown'> & { original: string }
	>()
	const [candidateReview, setCandidateReview] = useState<TypstPreparedCandidate>()
	const [candidateText, setCandidateText] = useState('')
	const [message, setMessage] = useState('')
	const [pane, setPane] = useState<'editor' | 'preview'>('editor')
	const [diagnosis, setDiagnosis] = useState<Diagnosis>()
	const [displayedRevision, setDisplayedRevision] = useState<number>()
	const [baseline, setBaseline] = useState(() => ({
		kind: 'example' as 'example' | 'saved',
		content: JSON.stringify({ draft: initialDraft, source: initialSource }),
	}))
	const [saveError, setSaveError] = useState('')
	const [unappliedInput, setUnappliedInput] = useState(false)
	const [composing, setComposing] = useState(false)
	const [permission, setPermission] = useState(true)
	const [editable, setEditable] = useState(true)
	const [importResult, setImportResult] = useState('')
	const [error, setError] = useState('')
	const [busy, setBusy] = useState(false)
	const [zoom, setZoom] = useState(1)
	const [navigation, setNavigation] = useState('')
	const container = useRef<HTMLDivElement>(null)
	const workspace = useRef<HTMLDivElement>(null)
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
	const pendingReveal = useRef<{ position: SourcePosition; revision: number } | undefined>(
		undefined,
	)
	const pointer = useRef<{ x: number; y: number } | null>(null)
	const [clientId] = useState(() => crypto.randomUUID())
	const parsedData = parseData(draft.data)
	const dirty = JSON.stringify({ draft, source }) !== baseline.content
	const pendingData = dataText !== JSON.stringify(draft.data, null, 2)
	const hasUnappliedInput = () =>
		!!workspace.current?.querySelector('[data-typst-unapplied="true"]')
	const replacementGuard = useRef<() => boolean>(() => false)
	replacementGuard.current = () => dirty || pendingData || hasUnappliedInput()
	const previewCurrent =
		compiled?.clientRevision === revision && displayedRevision === revision && !busy
	// A region projection changes with its content, not with every caret movement.
	const markdownSelectionVersion = candidateScope === 'blocks' ? selectionVersion : 0
	const liveMarkdown = useMemo(() => {
		if (outputTab !== 'candidate' || markdownEditing) return undefined
		let document = draft.regions[region]!
		if (candidateScope === 'blocks') {
			const editor = editors.current.get(region)
			if (!editor) return undefined
			const target = captureTypstCandidateTarget({
				selection: editor.state.selection,
				regionId: region,
				baseRevision: 0,
				scope: 'blocks',
			})
			if (!target.ok) return target
			const { from, to } = target.value.range!
			document = editor.state.doc.copy(editor.state.doc.slice(from, to).content).toJSON()
		}
		return exportTypstMarkdown({
			format: 'agent',
			document,
			regionId: region,
			config,
			data: parseData(draft.data),
		})
	}, [
		outputTab,
		markdownEditing,
		draft.regions,
		draft.data,
		region,
		config,
		parseData,
		candidateScope,
		markdownSelectionVersion,
	])

	function confirmReplacement() {
		if (
			!replacementGuard.current() ||
			window.confirm('存在未保存修改或未应用输入。放弃这些修改并替换当前草稿？')
		)
			return true
		setMessage('已取消替换，正文、输入和撤销历史保留')
		return false
	}
	useEffect(() => {
		if (!workspace.current) return
		// The same marker drives the status and synchronous save/leave guards. Observe
		// cancellation, application and mount changes as well as text input.
		const update = () => setUnappliedInput(hasUnappliedInput())
		const observer = new MutationObserver(update)
		observer.observe(workspace.current, {
			subtree: true,
			childList: true,
			attributes: true,
			attributeFilter: ['data-typst-unapplied'],
		})
		update()
		return () => observer.disconnect()
	}, [])
	useEffect(() => {
		const guard = (event: BeforeUnloadEvent) => {
			if (!replacementGuard.current()) return
			event.preventDefault()
			event.returnValue = ''
		}
		window.addEventListener('beforeunload', guard)
		return () => window.removeEventListener('beforeunload', guard)
	}, [])

	function change(update: (previous: TypstDocumentDraft) => TypstDocumentDraft) {
		setDraft(update)
		setRevision((value) => value + 1)
	}
	async function loadExample(id: string) {
		const serial = ++exampleLoad.current
		try {
			const next = getExample(id)
			const template = await readExampleSource(next)
			if (serial !== exampleLoad.current || !confirmReplacement()) return
			setBaseline({
				kind: 'example',
				content: JSON.stringify({ draft: next.draft, source: template }),
			})
			setSaveError('')
			setDraft(structuredClone(next.draft))
			setDataText(JSON.stringify(next.draft.data, null, 2))
			setSource(template)
			setRegion('body')
			setWorkspaceTab('editor')
			setCandidateTarget(undefined)
			setCandidateReview(undefined)
			setMarkdownEditing(false)
			setCandidateText('')
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
			setDataText(JSON.stringify(checked.value.data, null, 2))
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
						if (!alive.current || snapshot.revision !== current.current.revision) continue
						if (!response.ok) {
							setDiagnosis({
								revision: snapshot.revision,
								mapping: value.mapping ?? [],
								diagnostics: value.diagnostics ?? [],
								failure: value,
							})
							continue
						}
						setDiagnosis({
							revision: snapshot.revision,
							mapping: value.mapping,
							diagnostics: value.diagnostics,
						})
						setCompiled({
							...value,
							preview: { ...value.preview, data: new Uint8Array(value.preview.data) },
						})
					} catch (cause) {
						if (alive.current && snapshot.revision === current.current.revision)
							setDiagnosis({
								revision: snapshot.revision,
								mapping: [],
								diagnostics: [],
								failure: {
									kind: 'unexpected',
									name: cause instanceof Error ? cause.name : 'UnknownError',
									code: 'TRANSPORT_FAILED',
									message: String(cause),
									diagnostics: [],
								},
							})
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
						if (snapshot) navigateToSource(point, snapshot.clientRevision, snapshot.mapping)
					},
				})
			}
			if (canceled) return
			if (await view.current.show(compiled.preview)) {
				displayed.current = compiled
				setDisplayedRevision(compiled.clientRevision)
			}
		})().catch((cause) => {
			if (!canceled) setError(String(cause))
		})
		return () => {
			canceled = true
		}
	}, [compiled])

	function navigateToSource(
		position: SourcePosition,
		snapshotRevision: number,
		mapping: TypstGeneratedMapping[],
	) {
		if (snapshotRevision !== current.current.revision) return
		const serial = ++navigationSerial.current
		pendingReveal.current = undefined
		const target = findTypstRegionPosition({ mapping, position, snapshotRevision })
		if (target) {
			setPane('editor')
			setWorkspaceTab('editor')
			setRegion(target.regionId)
			requestAnimationFrame(() => {
				if (serial !== navigationSerial.current || snapshotRevision !== current.current.revision)
					return
				const editor = editors.current.get(target.regionId)
				if (!editor) return
				const from = Math.min(Math.max(0, target.from), editor.state.doc.content.size)
				const node = editor.state.doc.nodeAt(from)
				const selection =
					node?.isAtom && !node.isText && NodeSelection.isSelectable(node)
						? NodeSelection.create(editor.state.doc, from)
						: TextSelection.near(editor.state.doc.resolve(from))
				// ProseMirror scrolls only when the DOM selection belongs to this editor.
				editor.view.focus()
				editor.view.dispatch(
					editor.state.tr
						.setSelection(selection)
						.setMeta('typst-navigation', target.source ?? true),
				)
				// Selection can open table/formula controls and resize the viewport before scrolling.
				requestAnimationFrame(() => {
					if (
						serial === navigationSerial.current &&
						snapshotRevision === current.current.revision &&
						!editor.isDestroyed &&
						editor.state.selection.eq(selection) &&
						editor.view.dom.getClientRects().length > 0
					)
						editor.view.dispatch(editor.state.tr.scrollIntoView())
				})
				setNavigation(`region:${target.regionId}:${target.from}`)
			})
		} else if (position.path === 'main.typ') {
			const offset = sourceOffset(current.current.source, position)
			if (offset === undefined) return
			setPane('preview')
			setOutputTab('template')
			requestAnimationFrame(() => {
				if (serial !== navigationSerial.current || snapshotRevision !== current.current.revision)
					return
				sourceEditor.current?.setSelectionRange(offset, offset)
				// Native textarea focus reveals its current selection, including distant wrapped lines.
				sourceEditor.current?.focus()
				setNavigation(`source:${position.line}:${position.column}`)
			})
		}
	}

	function revealSource(position: SourcePosition) {
		if (displayed.current?.clientRevision !== current.current.revision) return
		++navigationSerial.current
		if (!viewport.current?.getClientRects().length) {
			// Keep Markdown/source editing visible; apply the latest target when preview opens.
			pendingReveal.current = { position, revision: current.current.revision }
			return
		}
		pendingReveal.current = undefined
		if (view.current?.revealSource(position))
			setNavigation(`preview:${position.path}:${position.line}`)
	}
	useEffect(() => {
		const target = pendingReveal.current
		if (!target) return
		if (target.revision !== revision) pendingReveal.current = undefined
		else if (viewport.current?.getClientRects().length) revealSource(target.position)
	}, [outputTab, pane, displayedRevision, revision])

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
		try {
			if (pendingData || hasUnappliedInput())
				throw new Error(
					'请先应用数据、源码块、Markdown 修改或确认组件参数，再保存。未应用输入仍保留。',
				)
			const checked = validateTypstDraft({
				draft,
				config,
				templateId: example.id,
				templateRevision: example.draft.templateRevision,
			})
			if (!checked.ok) throw new Error(JSON.stringify(checked.issues))
			const content = JSON.stringify({ draft: checked.value, source })
			localStorage.setItem('typst-consumer-draft', content)
			setBaseline({ kind: 'saved', content })
			setSaveError('')
			setMessage('已保存原始输入、区域 JSON 与模板到本浏览器的单一保存槽')
		} catch (cause) {
			setSaveError(String(cause))
		}
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
			if (!confirmReplacement()) return
			setBaseline({
				kind: 'saved',
				content: JSON.stringify({ draft: checked.value, source: saved.source }),
			})
			setSaveError('')
			setDraft(checked.value)
			setSource(saved.source)
			setDataText(JSON.stringify(checked.value.data, null, 2))
			setRegion('body')
			setWorkspaceTab('editor')
			setCandidateTarget(undefined)
			setCandidateReview(undefined)
			setMarkdownEditing(false)
			setCandidateText('')
			setError('')
			setEpoch((value) => value + 1)
			setRevision((value) => value + 1)
			setMessage('已重开保存的草稿')
		} catch (cause) {
			setError(String(cause))
		}
	}

	function fixCandidateTarget() {
		const editor = editors.current.get(region)
		if (!editor) return
		const target = captureTypstCandidateTarget({
			selection: editor.state.selection,
			regionId: region,
			baseRevision: revision,
			scope: candidateScope,
		})
		if (!target.ok) {
			setError(JSON.stringify(target.issues))
			return
		}
		const from = target.value.range?.from ?? 0
		const to = target.value.range?.to ?? editor.state.doc.content.size
		const original = exportTypstMarkdown({
			format: 'agent',
			document: editor.state.doc.copy(editor.state.doc.slice(from, to).content).toJSON(),
			regionId: region,
			config,
			data: parsedData,
		})
		if (!original.ok) {
			setError(JSON.stringify(original.issues))
			return
		}
		const retainCandidate = candidateText !== '' && candidateText !== candidateTarget?.original
		if (!retainCandidate) setCandidateText(original.value.markdown)
		setCandidateTarget({
			...target.value,
			original: original.value.markdown,
		})
		setCandidateReview(undefined)
		setError('')
		setMarkdownEditing(true)
		setMessage(
			`已固定草稿 ${revision} 的候选目标。${retainCandidate ? '已保留候选框中的修改；可用原文替换候选。' : '原文已载入候选，可直接编辑。'}`,
		)
	}
	function reviewCandidate() {
		if (!candidateTarget) return
		const editor = editors.current.get(candidateTarget.regionId)
		if (!editor) return
		const prepared = prepareTypstCandidate({
			candidate: {
				format: 'agent',
				regionId: candidateTarget.regionId,
				baseRevision: candidateTarget.baseRevision,
				range: candidateTarget.range,
				markdown: candidateText,
			},
			currentRevision: current.current.revision,
			document: editor.getJSON(),
			config,
			data: parseData(current.current.draft.data),
			canEdit: (id) => permission && editable && !composing && id === candidateTarget.regionId,
		})
		if (!prepared.ok) {
			setCandidateReview(undefined)
			setError(JSON.stringify(prepared.issues))
			return
		}
		setCandidateReview(prepared.value)
		setError('')
	}
	function acceptCandidate() {
		if (!candidateReview) return
		const editor = editors.current.get(candidateReview.regionId)
		if (!editor) return
		const result = applyTypstCandidate({
			candidate: candidateReview,
			editor,
			regionId: candidateReview.regionId,
			currentRevision: () => current.current.revision,
			config,
			data: () => parseData(current.current.draft.data),
			canEdit: (id) => permission && editable && !composing && id === candidateReview.regionId,
		})
		if (!result.ok) setError(JSON.stringify(result.issues))
		else {
			setCandidateReview(undefined)
			setError('')
			setMessage('候选已接纳，可一次撤销')
			setRegion(candidateReview.regionId)
			setWorkspaceTab('editor')
			setMarkdownEditing(false)
			setCandidateTarget(undefined)
			setCandidateText('')
		}
	}

	return (
		<main
			onCompositionStartCapture={() => setComposing(true)}
			onCompositionEndCapture={() => setComposing(false)}
		>
			<header>
				<div>
					<p className="eyebrow">PLUXEL / TYPST</p>
					<h1>编辑与排版体验</h1>
				</div>
				<span>块前操作柄调整结构 · 文字右键设置格式 · 正文与预览双向定位</span>
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
							onChange={(event) => {
								const data = { customer: { name: event.target.value } }
								setDataText(JSON.stringify(data, null, 2))
								change((previous) => ({ ...previous, data }))
							}}
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
					disabled={!previewCurrent}
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
					草稿 {revision} / 预览 {displayedRevision ?? '—'}
					{busy ? ' · 编译中' : previewCurrent ? ' · 当前' : ' · 过期'}
				</output>
				<output data-testid="save-state" title="单一保存槽；仅保存到当前浏览器">
					{saveError
						? '保存失败'
						: baseline.kind === 'saved' && !dirty
							? '已保存到本浏览器'
							: '未保存'}
					{(pendingData || unappliedInput) && ' · 有未应用输入'}
				</output>
			</div>
			{example.id === 'operations-report' && (
				<p className="example-guide">
					经营解读试图表、公式与引用；后续行动试文字与表格样式。右侧可切换 Markdown 对照编辑。
				</p>
			)}
			{saveError && <pre role="alert">{saveError}</pre>}
			{error && <pre role="alert">{error}</pre>}
			{diagnosis && (diagnosis.failure || diagnosis.diagnostics.length > 0) && (
				<details className="compile-diagnostics" open={!!diagnosis.failure}>
					<summary>
						编译诊断 · 草稿 {diagnosis.revision}
						{diagnosis.revision !== revision && '（已过期，不能定位）'}
					</summary>
					{diagnosis.failure && (
						<p role="alert">
							{diagnosis.failure.kind} / {diagnosis.failure.code} · {diagnosis.failure.name}:{' '}
							{diagnosis.failure.message}
						</p>
					)}
					<ul>
						{diagnosis.diagnostics.map((item, index) => {
							const position = diagnosticPosition(item)
							const mapped =
								position &&
								(position.path === 'main.typ' ||
									findTypstRegionPosition({
										mapping: diagnosis.mapping,
										position,
										snapshotRevision: diagnosis.revision,
									}))
							return (
								<li key={index}>
									<span>
										{item.severity} · {item.message} {item.path}
										{position && `:${position.line}:${position.column}`}
									</span>
									{position && (
										<button
											type="button"
											disabled={diagnosis.revision !== revision || !mapped}
											onClick={() =>
												navigateToSource(position, diagnosis.revision, diagnosis.mapping)
											}
										>
											定位诊断 {index + 1}
										</button>
									)}
									{position?.path.startsWith('_editor/') && !mapped && (
										<small>无匹配映射；请核对区域配置和模板组件定义。</small>
									)}
								</li>
							)
						})}
					</ul>
					{diagnosis.failure && diagnosis.mapping.length === 0 && (
						<p>没有本次请求的生成映射；仅展示可用诊断。</p>
					)}
				</details>
			)}
			<nav className="pane-switch" aria-label="编辑与预览">
				<button type="button" aria-pressed={pane === 'editor'} onClick={() => setPane('editor')}>
					编辑
				</button>
				<button type="button" aria-pressed={pane === 'preview'} onClick={() => setPane('preview')}>
					预览
				</button>
			</nav>
			<div className="columns" data-pane={pane} ref={workspace}>
				<section className="editing">
					<TabBar
						label="编辑工作区"
						tabs={workspaceTabs}
						value={workspaceTab}
						onChange={setWorkspaceTab}
					/>
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
										(event.target as HTMLElement).closest('input, textarea, select, button, a') ||
										!(event.target as HTMLElement).closest('.tiptap')
									)
										return
									const editor = editors.current.get(item.id)
									if (editor?.state.selection instanceof NodeSelection) {
										const position = editor.state.selection.from
										if (editor.view.nodeDOM(position)?.contains(event.target as Node)) {
											revealRegion(item.id, position)
											return
										}
									}
									const selection = editor?.view.dom.ownerDocument.getSelection()
									if (
										!editor ||
										!selection?.isCollapsed ||
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
									regions={draft.regions}
									config={config}
									data={parsedData}
									fontFamilies={fontFamilies}
									slashCommands={consumerSlashCommands}
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
										if (
											outputTab === 'candidate' &&
											candidateScope === 'blocks' &&
											!markdownEditing &&
											region === item.id
										)
											setSelectionVersion((value) => value + 1)
									}}
								>
									{(editor) =>
										example.id === 'operations-report' && (
											<ChannelParameters editor={editor} editable={editable} />
										)
									}
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
				</section>
				<section className="output-pane">
					<TabBar label="文档视图" tabs={outputTabs} value={outputTab} onChange={setOutputTab} />
					<div
						id="panel-preview"
						role="tabpanel"
						aria-labelledby="tab-preview"
						hidden={outputTab !== 'preview'}
						className="workspace-panel preview-pane"
					>
						<h2>Typst 排版预览</h2>
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
					</div>
					<div
						id="panel-template"
						role="tabpanel"
						aria-labelledby="tab-template"
						hidden={outputTab !== 'template'}
						className="workspace-panel input-panel"
					>
						<div className="panel-intro">
							<h2>原始 Typst</h2>
							<p>模板源码实时编译，正文按区域插入模板。点击预览中的固定文字可定位到源码。</p>
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
						hidden={outputTab !== 'candidate'}
						className="workspace-panel input-panel"
					>
						<div className="panel-intro">
							<h2 id="markdown-heading">Markdown</h2>
							<p>
								{markdownEditing
									? '编辑候选，检查后接纳。正文和排版会同步更新，可一次撤销。'
									: '实时查看正文的 agent Markdown；颜色、字体和模板信息随正文保留。'}
							</p>
						</div>
						<label>
							目标区域{' '}
							<select
								aria-label="候选目标区域"
								value={region}
								onChange={(event) => {
									setRegion(event.currentTarget.value)
									setCandidateTarget(undefined)
									setCandidateReview(undefined)
								}}
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
								onChange={(event) => {
									setCandidateScope(event.currentTarget.value as 'region' | 'blocks')
									setCandidateTarget(undefined)
									setCandidateReview(undefined)
								}}
							>
								<option value="region">整个区域</option>
								<option value="blocks">当前选中块</option>
							</select>
						</label>
						<p className="candidate-hint">
							分段修改：在正文放置光标，再选“当前选中块”。模板组件和表格可独立保留。
						</p>
						<div className="panel-actions">
							<output>
								{markdownEditing ? '候选修改 · 尚未写回' : `实时正文 · 草稿 ${revision}`}
							</output>
							{markdownEditing ? (
								<button
									type="button"
									disabled={composing}
									onClick={() => {
										setMarkdownEditing(false)
										setCandidateTarget(undefined)
										setCandidateReview(undefined)
										setCandidateText('')
										setImportResult('')
										setError('')
									}}
								>
									放弃候选修改
								</button>
							) : (
								<button
									type="button"
									onClick={fixCandidateTarget}
									disabled={composing || !editable || !liveMarkdown?.ok}
								>
									编辑这份 Markdown
								</button>
							)}
						</div>
						{!markdownEditing && (
							<>
								<textarea
									aria-label="实时 Markdown"
									readOnly
									spellCheck={false}
									value={liveMarkdown?.ok ? liveMarkdown.value.markdown : ''}
								/>
								{liveMarkdown && !liveMarkdown.ok && (
									<pre role="alert">{JSON.stringify(liveMarkdown.issues)}</pre>
								)}
							</>
						)}
						<textarea
							aria-label="候选 Markdown"
							data-typst-unapplied={
								markdownEditing && candidateText !== candidateTarget?.original ? 'true' : undefined
							}
							hidden={!markdownEditing}
							spellCheck={false}
							value={candidateText}
							onChange={(event) => {
								setCandidateText(event.target.value)
								setCandidateReview(undefined)
							}}
						/>
						<div className="panel-actions" hidden={!markdownEditing}>
							<label>
								<input
									type="checkbox"
									checked={permission}
									onChange={(event) => setPermission(event.target.checked)}
								/>
								允许接纳候选
							</label>
							<button type="button" onClick={fixCandidateTarget} disabled={composing}>
								固定候选目标
							</button>
							<button
								type="button"
								disabled={!candidateTarget || composing}
								onClick={() => {
									if (!candidateTarget) return
									setCandidateText(candidateTarget.original)
									setCandidateReview(undefined)
								}}
							>
								用原文替换候选
							</button>
							<button
								type="button"
								onClick={reviewCandidate}
								disabled={!candidateTarget || composing}
							>
								查看修改预览
							</button>
							<button
								type="button"
								onClick={acceptCandidate}
								disabled={!candidateReview || composing}
							>
								接纳候选
							</button>
							<button
								type="button"
								onClick={() =>
									setImportResult(
										JSON.stringify(
											parseTypstMarkdown({
												format: 'agent',
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
						{markdownEditing && candidateTarget && (
							<div className="candidate-review" data-testid="candidate-review">
								<p>
									目标：{candidateTarget.regionId} · 草稿 {candidateTarget.baseRevision} ·{' '}
									{candidateTarget.range
										? `完整块 [${candidateTarget.range.from}, ${candidateTarget.range.to})`
										: '整个区域'}
									。范围外的图表、组件和表格保持原样。
								</p>
								{candidateTarget.baseRevision !== revision && (
									<p>目标已过期；保留对照，接纳时会拒绝。请明确重新固定目标。</p>
								)}
								<div className="candidate-comparison">
									<section>
										<h3>原内容</h3>
										<pre>{candidateTarget.original}</pre>
									</section>
									<section>
										<h3>待替换内容</h3>
										<pre>{candidateText}</pre>
									</section>
								</div>
								<p>
									{candidateReview
										? '已准备：接纳将提交以上候选，一次撤销可恢复。'
										: '尚未准备或文字已修改，请查看修改预览后再接纳。'}
								</p>
							</div>
						)}
						{importResult && <pre data-testid="import-result">{importResult}</pre>}
					</div>
				</section>
			</div>
			<footer className="workspace-status">
				<span role="status">
					{message || '切换工作标签保留编辑内容；保存使用本浏览器的单一槽位。'}
				</span>
				<output data-testid="navigation">{navigation}</output>
			</footer>
		</main>
	)
}

const root = createRoot(document.getElementById('root')!)
root.render(
	<main>
		<p role="status">正在载入示例…</p>
	</main>,
)
async function mountExample() {
	try {
		const example = getExample(
			new URLSearchParams(location.search).get('example') ?? 'operations-report',
		)
		const source = await readExampleSource(example)
		root.render(<App initialDraft={example.draft} initialSource={source} />)
	} catch (cause) {
		root.render(
			<main>
				<p role="alert">无法载入示例：{String(cause)}</p>
			</main>,
		)
	}
}
void mountExample()
