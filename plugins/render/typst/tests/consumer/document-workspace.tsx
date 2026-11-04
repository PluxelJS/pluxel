import {
	createContext,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
	type ReactNode,
} from 'react'
import type { Editor } from '@tiptap/core'
import { createRoute, type AnyRouter } from '@tanstack/react-router'
import { useWorkbenchContent, useWorkbenchState, type WorkbenchInstance } from '@worksplit/react'
import { Actions, DockLocation } from 'flexlayout-react'
import { TypstDocumentEditor } from '@pluxel/plugin-typst/tiptap/document/react'
import { DocumentClient, type DocumentClientState } from './document-client'
import { DocumentPreview as Preview } from './document-preview'
import type { TypstDocumentSelection } from '@pluxel/plugin-typst/document'
import { rootRoute } from './workspace-route'

interface DocumentWorkspaceValue {
	client: DocumentClient
	state: DocumentClientState
	workbench: WorkbenchInstance<AnyRouter>
	active: string
	focus?: { chapterId: string; position?: number; serial: number }
	selection?: TypstDocumentSelection
	locate(chapterId: string, position: number, explicit?: boolean): void
	openChapter(id: string, position?: number, previewRevision?: number): Promise<void>
	showPreview(): Promise<void>
	open(): Promise<void>
}
const Context = createContext<DocumentWorkspaceValue | null>(null)
const useDocumentWorkspace = () => useContext(Context)!
const ignore = () => {}

const chapterRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/chapter/$id',
	component: () => <ChapterPane chapterId={chapterRoute.useParams().id} />,
	staticData: { worksplit: { title: '章节', navigationKey: 'chapter' } },
})
const previewRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/preview',
	component: DocumentPreview,
	staticData: { worksplit: { title: '项目书 · 预览', navigationKey: 'preview' } },
})
export const documentRoutes = [chapterRoute, previewRoute] as const

export function ChapterExplorer() {
	const { state, client, active, openChapter, open } = useDocumentWorkspace()
	const [creating, setCreating] = useState(false)
	const [title, setTitle] = useState('')
	useEffect(() => {
		void open().catch(ignore)
	}, [])
	if (!state.view)
		return (
			<aside className="chapter-explorer" aria-label="项目章节">
				<p className="document-opening">{state.error ? '文档暂未打开。' : '正在打开项目书…'}</p>
			</aside>
		)
	const chapters = state.view.documents
	function move(id: string, offset: number) {
		const ids = chapters.map((chapter) => chapter.id)
		const from = ids.indexOf(id)
		const to = from + offset
		if (to < 0 || to >= ids.length) return
		;[ids[from], ids[to]] = [ids[to]!, ids[from]!]
		void client.perform({ action: 'reorder', chapterIds: ids }).catch(ignore)
	}
	return (
		<aside className="chapter-explorer" aria-label="项目章节">
			<div className="explorer-heading">
				<h2>项目书</h2>
				<button type="button" aria-label="新建章节" onClick={() => setCreating(true)}>
					＋
				</button>
			</div>
			<ol className="chapter-list">
				{chapters.map((chapter, index) => (
					<li key={chapter.id} data-chapter-id={chapter.id}>
						<button
							type="button"
							className="chapter-open"
							aria-current={active === chapter.id ? 'page' : undefined}
							onClick={() => {
								void openChapter(chapter.id)
							}}
						>
							<span aria-hidden="true">{index + 1}</span>
							{chapter.title}
						</button>
						<div className="chapter-order">
							<button
								type="button"
								aria-label={`上移${chapter.title}`}
								disabled={index === 0 || state.busy}
								onClick={() => move(chapter.id, -1)}
							>
								↑
							</button>
							<button
								type="button"
								aria-label={`下移${chapter.title}`}
								disabled={index === chapters.length - 1 || state.busy}
								onClick={() => move(chapter.id, 1)}
							>
								↓
							</button>
						</div>
					</li>
				))}
			</ol>
			{creating && (
				<form
					className="chapter-create"
					onSubmit={(event) => {
						event.preventDefault()
						const id = `c-${crypto.randomUUID()}`
						void client
							.perform({ action: 'create', chapterId: id, title: title.trim() })
							.then(async () => {
								setCreating(false)
								setTitle('')
								return openChapter(id)
							})
							.catch(ignore)
					}}
				>
					<label htmlFor="new-chapter-title">章节名称</label>
					<input
						id="new-chapter-title"
						autoFocus
						value={title}
						maxLength={200}
						onChange={(event) => setTitle(event.currentTarget.value)}
						onKeyDown={(event) => {
							if (event.key === 'Escape') setCreating(false)
						}}
					/>
					<div>
						<button type="submit" disabled={!title.trim() || state.busy}>
							创建章节
						</button>
						<button type="button" onClick={() => setCreating(false)}>
							取消
						</button>
					</div>
				</form>
			)}
			<p className="chapter-help">点击章节开始编辑。正文中的引用可直接跳转。</p>
		</aside>
	)
}

function ChapterPane({ chapterId }: { chapterId: string }) {
	const workspace = useDocumentWorkspace()
	const { state, client, workbench } = workspace
	const chapter = state.view!.documents.find(({ id }) => id === chapterId)
	const document = state.drafts[chapterId] ?? chapter?.document
	const editor = useRef<Editor | null>(null)
	const panel = useRef<HTMLElement>(null)
	const initial = useRef(JSON.stringify(chapter?.document))
	const changed = JSON.stringify(document) !== initial.current
	const [title, setTitle] = useState(chapter?.title ?? '')
	function hasPendingInput() {
		if (panel.current?.querySelector('[data-typst-unapplied]')) return true
		return [...(panel.current?.querySelectorAll('[aria-controls]') ?? [])].some((anchor) =>
			globalThis.document
				.getElementById(anchor.getAttribute('aria-controls')!)
				?.querySelector('[data-typst-unapplied]'),
		)
	}
	const content = useWorkbenchContent({
		isDirty: () => Boolean(chapter) && (changed || hasPendingInput()),
		getCloseRevision: () => `${state.view!.revision}:${JSON.stringify(document)}`,
		beforeLeave: () =>
			!chapter ||
			!hasPendingInput() ||
			window.confirm('放弃尚未确认的输入？已经同步的正文仍保留在文档中。'),
		focus: () => editor.current?.commands.focus(),
		save: () => {
			void client.perform({ action: 'save' }).catch(ignore)
		},
	})
	useEffect(() => {
		if (!chapter) {
			void workbench.close(content.id)
			return
		}
		setTitle(chapter.title)
		void workbench.dispatch(Actions.renameTab(content.id, chapter.title))
	}, [chapter?.title, content.id])
	const focus = workspace.focus?.chapterId === chapterId ? workspace.focus : undefined
	useEffect(() => {
		if (focus?.position !== undefined) editor.current?.commands.focus(focus.position || 'start')
	}, [focus?.serial])
	if (!chapter || !document) return <p>章节已移除。</p>
	function rename() {
		if (title.trim() === chapter!.title) return
		void client.perform({ action: 'rename', chapterId, title: title.trim() }).catch(ignore)
	}
	return (
		<section
			ref={panel}
			className="workspace-panel document-chapter"
			aria-label="章节编辑器"
			data-chapter-id={chapterId}
			onFocusCapture={(event) => {
				if (editor.current?.view.dom.contains(event.target as Node))
					workspace.locate(chapterId, editor.current.state.selection.from)
			}}
		>
			<div className="chapter-heading">
				<label htmlFor={`title-${content.id}`}>章节名称</label>
				<input
					id={`title-${content.id}`}
					aria-label="章节名称"
					value={title}
					maxLength={200}
					onChange={(event) => setTitle(event.currentTarget.value)}
					onBlur={rename}
					onKeyDown={(event) => {
						if (event.key === 'Enter') {
							event.preventDefault()
							event.currentTarget.blur()
						}
					}}
				/>
			</div>
			<div className="editor-panel">
				<TypstDocumentEditor
					content={document}
					editable={chapter.editable}
					onChange={(next) => {
						workbench.keep(content.id)
						client.edit(chapterId, next)
					}}
					fontFamilies={['Noto Serif CJK SC', 'Liberation Serif']}
					references={state.view!.references}
					history={{
						canUndo: state.view!.canUndo || Object.keys(state.drafts).length > 0,
						canRedo: state.view!.canRedo,
						undo: () => {
							void client.perform({ action: 'undo' }).catch(ignore)
						},
						redo: () => {
							void client.perform({ action: 'redo' }).catch(ignore)
						},
					}}
					onEditor={(instance) => {
						editor.current = instance
						if (instance && focus?.position !== undefined)
							instance.commands.focus(focus.position || 'start')
					}}
					onSelection={(position) => {
						if (editor.current?.isFocused) workspace.locate(chapterId, position)
					}}
					onReference={(id, position) => {
						void workspace.openChapter(id, position)
					}}
					onReveal={(position) => {
						workspace.locate(chapterId, position, true)
					}}
				/>
			</div>
		</section>
	)
}

function DocumentPreview() {
	const { state, client, selection, openChapter } = useDocumentWorkspace()
	return (
		<Preview
			state={state}
			client={client}
			selection={selection}
			onSelect={({ documentId, position }) => {
				void openChapter(documentId, position, state.view!.revision)
			}}
		/>
	)
}

/** The document host borrows the workspace; changing tools never closes its save lane. */
export function DocumentWorkspaceProvider({
	workbench,
	children,
}: {
	workbench: WorkbenchInstance<AnyRouter>
	children: ReactNode
}) {
	const [client] = useState(() => new DocumentClient())
	const state = useSyncExternalStore(client.subscribe, client.getSnapshot)
	const activeId = useWorkbenchState(workbench, (value) => value.activeDocumentId)
	const [active, setActive] = useState('background')
	const [focus, setFocus] = useState<DocumentWorkspaceValue['focus']>()
	const [selection, setSelection] = useState<TypstDocumentSelection>()
	const serial = useRef(0)
	const opening = useRef<Promise<void> | undefined>(undefined)
	function ensureOpen() {
		if (client.getSnapshot().view) return Promise.resolve()
		return (opening.current ??= client.open().finally(() => {
			opening.current = undefined
		}))
	}
	async function open() {
		await ensureOpen()
		if (!workbench.getDocuments().some((doc) => doc.navigationKey === 'chapter'))
			await openChapter(client.getSnapshot().view!.documents[0]!.id)
	}
	async function showPreview(preserveFocus = false) {
		const current = workbench.getActiveDocument()
		const existing = workbench.getDocuments().find((doc) => doc.href === '/preview')
		const anyPreview = workbench.getDocuments().find((doc) => doc.navigationKey === 'preview')
		const target = existing?.containerId ?? anyPreview?.containerId ?? current?.containerId
		if (!target) return
		const sameGroup = target === current?.containerId
		await workbench.open(
			{ to: '/preview' },
			{
				target,
				...(!existing && !anyPreview ? { location: DockLocation.RIGHT } : {}),
				...(preserveFocus
					? sameGroup && (existing || anyPreview)
						? { background: true }
						: { preserveFocus: true }
					: {}),
				reuse: 'preserve',
			},
		)
	}
	function locate(chapterId: string, position: number, explicit = false) {
		setSelection({ documentId: chapterId, position, explicit })
		if (explicit) void showPreview(true)
	}
	async function openChapter(id: string, position?: number, previewRevision?: number) {
		await ensureOpen()
		const current = () => {
			const snapshot = client.getSnapshot()
			return (
				previewRevision === undefined ||
				(snapshot.view?.revision === previewRevision && Object.keys(snapshot.drafts).length === 0)
			)
		}
		if (!current()) return
		const editors = workbench
			.getDocuments()
			.filter((doc) => doc.navigationKey === 'editor' || doc.navigationKey === 'chapter')
		const candidate =
			editors.find((doc) => doc.id === workbench.getActiveDocument()?.id) ?? editors[0]
		const previousId = workbench.getActiveDocument()?.id
		const result = await workbench.open(
			{ to: '/chapter/$id', params: { id } },
			{ target: candidate?.containerId, preview: true, reuse: 'preserve' },
		)
		if (result.status !== 'committed' || !current()) return
		setActive(id)
		locate(id, position ?? 0)
		setFocus(
			position === undefined ? undefined : { chapterId: id, position, serial: ++serial.current },
		)
		if (result.document.id === previousId) {
			workbench.activate('chapters', { focus: false })
			await showPreview(true)
		}
	}
	useEffect(() => {
		const beforeUnload = (event: BeforeUnloadEvent) => {
			if (client.unsaved) event.preventDefault()
		}
		window.addEventListener('beforeunload', beforeUnload)
		window.addEventListener('pagehide', client.close)
		return () => {
			window.removeEventListener('beforeunload', beforeUnload)
			window.removeEventListener('pagehide', client.close)
			client.close()
		}
	}, [client])
	useEffect(() => {
		const href = workbench.getActiveDocument()?.href
		if (href?.startsWith('/chapter/')) {
			setActive(decodeURIComponent(href.slice('/chapter/'.length)))
			workbench.activate('chapters', { focus: false })
			void showPreview(true)
		}
	}, [activeId])
	useEffect(() => {
		const chapters = state.view?.documents
		if (chapters && !chapters.some(({ id }) => id === active)) {
			setActive(chapters[0]!.id)
			if (workbench.getActiveDocument()?.navigationKey === 'chapter')
				void openChapter(chapters[0]!.id)
		}
	}, [state.view?.revision, active])
	const context = useMemo(
		() => ({
			client,
			state,
			workbench,
			active,
			focus,
			selection,
			locate,
			openChapter,
			showPreview,
			open,
		}),
		[client, state, workbench, active, focus, selection],
	)
	return <Context.Provider value={context}>{children}</Context.Provider>
}

export function DocumentActions() {
	const { client, state } = useDocumentWorkspace()
	return (
		<>
			<span className="document-save-state" role="status">
				{state.busy
					? '正在同步…'
					: Object.keys(state.drafts).length > 0
						? '输入待同步'
						: state.view?.dirty
							? '待保存'
							: '已保存'}
			</span>
			<button
				type="button"
				disabled={!state.view}
				onClick={() => {
					void client.perform({ action: 'save' }).catch(ignore)
				}}
			>
				保存文档
			</button>
		</>
	)
}

export function DocumentStatus() {
	const { client, state, open } = useDocumentWorkspace()
	if (!state.message) return null
	return (
		<div className="source-status">
			<p role={state.error ? 'alert' : 'status'}>{state.message}</p>
			{state.error && (
				<button
					type="button"
					onClick={() => {
						void (state.view ? client.synchronize() : open()).catch(ignore)
					}}
				>
					重试
				</button>
			)}
			{state.error && Object.keys(state.drafts).length > 0 && (
				<button type="button" disabled={state.busy} onClick={() => client.discardDrafts()}>
					放弃未同步输入
				</button>
			)}
		</div>
	)
}
