import { useEffect, useMemo, useRef, useState } from 'react'
import { createRoute, createRouter } from '@tanstack/react-router'
import {
	createWorkbench,
	Workbench,
	useWorkbenchContent,
	useWorkbenchState,
} from '@worksplit/react'
import { Actions, DockLocation, type IJsonModel } from 'flexlayout-react'
import { findTypstEditorPosition } from '@pluxel/plugin-typst/source/browser'
import { FileExplorer, type WorkspaceFolders } from './file-explorer'
import { EditorPane } from './editor-pane'
import { PreviewPane } from './preview-pane'
import {
	ChapterExplorer,
	DocumentActions,
	DocumentStatus,
	DocumentWorkspaceProvider,
	documentRoutes,
} from './document-workspace'
import { rootRoute } from './workspace-route'
import type { ExampleId } from './examples'
import {
	WorkspaceContext,
	useWorkspace,
	type CaretSelection,
	type FileFocus,
	type WorkspaceContextValue,
} from './workspace-context'

export const storageKeys = {
	report: 'typst-source-project-v2',
	'application-form': 'typst-source-application-v1',
} as const
const defaultPath = (folder: ExampleId) =>
	folder === 'application-form' ? 'data/application.json' : 'sections/analysis.typ'
function hasProjectDraft(folder: ExampleId) {
	return [...document.querySelectorAll(`.workspace-panel[data-folder="${folder}"]`)].some(
		(panel) =>
			panel.querySelector('[data-typst-unapplied]') ||
			[...panel.querySelectorAll('[aria-controls]')].some((anchor) =>
				document
					.getElementById(anchor.getAttribute('aria-controls')!)
					?.querySelector('[data-typst-unapplied]'),
			),
	)
}
const editRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/edit/$folder/$',
	component: () => {
		const { folder, _splat } = editRoute.useParams()
		const workspace = useWorkspace()
		if (!Object.hasOwn(workspace.folders, folder) || !_splat)
			return <p role="alert">文件不存在。</p>
		return <EditorPane folder={folder as ExampleId} path={_splat} />
	},
	staticData: { worksplit: { title: '编辑器', navigationKey: 'editor' } },
})
const previewRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/preview/$folder',
	component: PreviewDocument,
	staticData: { worksplit: { title: '文档预览', navigationKey: 'preview' } },
})
const routeTree = rootRoute.addChildren([editRoute, previewRoute, ...documentRoutes])
function PreviewDocument() {
	const { folder: value } = previewRoute.useParams()
	const workspace = useWorkspace()
	const folder = value as ExampleId
	const content = useWorkbenchContent()
	useEffect(() => {
		void workspace.workbench.dispatch(Actions.renameTab(content.id, `${folder} · 预览`))
	}, [content.id, folder])
	if (!Object.hasOwn(workspace.folders, folder)) return <p role="alert">文件夹不存在。</p>
	const project = workspace.folders[folder].project
	return (
		<PreviewPane
			project={project}
			folder={folder}
			selection={workspace.selections[folder]}
			hasPending={Object.values(workspace.pending).some(
				(item) => item.folder === folder && item.pending,
			)}
			onIssue={workspace.report}
			onNavigate={(point) => {
				const path = point.path.replace(/^\//, '')
				if (!Object.hasOwn(project.snapshot().files, path)) return
				const position = path.endsWith('.typ')
					? findTypstEditorPosition({
							projection: project.open(path),
							sourcePosition: { ...point, path },
						})
					: undefined
				void workspace.openFile(
					folder,
					path,
					position,
					folder === 'application-form' && path === 'main.typ',
				)
			}}
		/>
	)
}

function ExplorerTool() {
	const workspace = useWorkspace()
	return (
		<FileExplorer
			folders={workspace.folders}
			activeFolder={workspace.active.folder}
			activePath={workspace.active.path}
			onOpen={(folder, path) => {
				void workspace.openFile(folder, path)
			}}
			onCreate={async (path) => {
				const project = workspace.folders[workspace.active.folder].project
				const result = project.createFile({ baseRevision: project.revision, path, contents: '' })
				if (!result.ok) return result.issues.map((issue) => issue.message).join('\n')
				await workspace.openFile(workspace.active.folder, path)
				return undefined
			}}
		/>
	)
}

function layout(): IJsonModel {
	return {
		global: {
			tabEnableFloat: false,
			tabEnablePopout: false,
			tabEnableRename: false,
			tabEnablePin: true,
			tabSetMinWidth: 100,
			tabSetMinHeight: 100,
			borderEnableAutoHide: true,
		},
		borders: [
			{
				type: 'border',
				location: 'left',
				size: 230,
				selected: 0,
				children: [
					{
						type: 'tab',
						id: 'files',
						name: '文件',
						component: 'worksplit.tool',
						enableClose: false,
						enableDrag: false,
					},
					{
						type: 'tab',
						id: 'chapters',
						name: '章节',
						component: 'worksplit.tool',
						enableClose: false,
						enableDrag: false,
					},
				],
			},
		],
		layout: { type: 'row', children: [] },
	}
}

/** Worksplit alone owns tab identities, preview replacement, selection and split geometry. */
export function Workspace({ folders }: { folders: WorkspaceFolders }) {
	const [message, report] = useState('')
	const [workbench] = useState(() =>
		createWorkbench({
			createRouter: (history) =>
				createRouter({ routeTree, history, defaultPendingMinMs: 0, defaultStaleTime: Infinity }),
			layout: layout(),
			home: '/',
			homeMode: 'empty',
			workspaceId: 'typst-playground',
			tools: [
				{ id: 'files', render: () => <ExplorerTool /> },
				{ id: 'chapters', render: () => <ChapterExplorer /> },
			],
			onIssue: ({ error }) => report(String(error)),
		}),
	)
	const activeId = useWorkbenchState(workbench, (state) => state.activeDocumentId)
	useWorkbenchState(workbench, (state) => state.revision)
	const [lastFile, setLastFile] = useState<{ folder: ExampleId; path: string }>({
		folder: 'report',
		path: defaultPath('report'),
	})
	const [focus, setFocus] = useState<FileFocus>()
	const [selections, setSelections] = useState<Partial<Record<ExampleId, CaretSelection>>>({})
	const [pending, setPending] = useState<Record<string, { folder: ExampleId; pending: boolean }>>(
		{},
	)
	const serial = useRef(0)
	const activeDocument = workbench.getActiveDocument()
	const activeHref = activeDocument?.href
	const isDocument = activeHref === '/preview' || activeHref?.startsWith('/chapter/')
	const parts = activeDocument
		? new URL(activeDocument.href, window.location.href).pathname.split('/').map(decodeURIComponent)
		: []
	const folder = Object.hasOwn(folders, parts[2] ?? '') ? (parts[2] as ExampleId) : lastFile.folder
	const active = {
		folder,
		path:
			parts[1] === 'edit'
				? parts.slice(3).join('/')
				: lastFile.folder === folder
					? lastFile.path
					: defaultPath(folder),
	}
	async function showPreview(targetFolder: ExampleId, preserveFocus = false) {
		const current = workbench.getActiveDocument()
		const existing = workbench.getDocuments().find((doc) => doc.href === `/preview/${targetFolder}`)
		const anyPreview = workbench.getDocuments().find((doc) => doc.navigationKey === 'preview')
		const target = existing?.containerId ?? anyPreview?.containerId ?? current?.containerId
		if (!target) return
		const sameGroup = target === current?.containerId
		const result = await workbench.open(
			{ to: '/preview/$folder', params: { folder: targetFolder } },
			{
				target,
				...(sameGroup && !existing && !anyPreview ? { location: DockLocation.RIGHT } : {}),
				...(preserveFocus
					? sameGroup && (existing || anyPreview)
						? { background: true }
						: { preserveFocus: true }
					: {}),
				reuse: 'preserve',
			},
		)
		if (result.status === 'failed') report(String(result.error))
	}
	async function openFile(
		targetFolder: ExampleId,
		path: string,
		position?: number,
		source?: boolean,
	) {
		const editors = workbench
			.getDocuments()
			.filter((doc) => doc.navigationKey === 'editor' || doc.navigationKey === 'chapter')
		const candidate =
			editors.find((doc) => doc.id === workbench.getActiveDocument()?.id) ?? editors[0]
		const target = candidate?.containerId ?? workbench.getActiveDocument()?.containerId
		const previousId = workbench.getActiveDocument()?.id
		const result = await workbench.open(
			{ to: '/edit/$folder/$', params: { folder: targetFolder, _splat: path } },
			{ target, preview: true, reuse: 'preserve' },
		)
		if (result.status !== 'committed') {
			if (result.status === 'failed') report(String(result.error))
			return
		}
		setLastFile({ folder: targetFolder, path })
		setFocus({ folder: targetFolder, path, position, source, serial: ++serial.current })
		if (result.document.id === previousId) {
			workbench.activate('files', { focus: false })
			await showPreview(targetFolder, true)
		}
	}
	function save(targetFolder: ExampleId) {
		if (hasProjectDraft(targetFolder)) {
			report('有尚未应用的源码或参数，请先应用或取消。')
			return false
		}
		try {
			localStorage.setItem(
				storageKeys[targetFolder],
				JSON.stringify(folders[targetFolder].project.snapshot().files),
			)
			report(`已保存源码修订 ${folders[targetFolder].project.revision}`)
			return true
		} catch (error) {
			report(`保存失败，当前源码仍保留在内存：${String(error)}`)
			return false
		}
	}
	useEffect(() => {
		void openFile('report', defaultPath('report'))
		return () => {
			void workbench.dispose()
		}
	}, [workbench])
	useEffect(() => {
		if (parts[1] === 'edit') {
			setLastFile(active)
			workbench.activate('files', { focus: false })
			void showPreview(active.folder, true)
		}
	}, [activeId, activeHref])
	const context = useMemo<WorkspaceContextValue>(
		() => ({
			folders,
			workbench,
			active,
			focus,
			selections,
			pending,
			openFile,
			selectCaret: (selectedFolder, selection) => {
				setSelections((current) => ({
					...current,
					[selectedFolder]: { ...selection, serial: ++serial.current },
				}))
				if (selection.explicit) void showPreview(selectedFolder)
			},
			setPending: (id, targetFolder, value) =>
				setPending((current) => {
					if (!value) {
						if (!Object.hasOwn(current, id)) return current
						const next = { ...current }
						delete next[id]
						return next
					}
					return current[id]?.pending === value && current[id]?.folder === targetFolder
						? current
						: { ...current, [id]: { folder: targetFolder, pending: value } }
				}),
			save,
			report,
		}),
		[folders, workbench, active.folder, active.path, focus, selections, pending],
	)
	return (
		<WorkspaceContext.Provider value={context}>
			<DocumentWorkspaceProvider workbench={workbench}>
				<main className="workspace">
					<header className="workspace-header">
						<div className="workspace-title">
							<div>
								<h1>Typst</h1>
								<p>{isDocument ? '分章项目书' : '文件工作区'}</p>
							</div>
						</div>
						<div className="host-actions">
							{isDocument ? (
								<DocumentActions />
							) : (
								<>
									<button type="button" onClick={() => save(active.folder)}>
										保存项目
									</button>
									<button
										type="button"
										onClick={() => {
											const saved = localStorage.getItem(storageKeys[active.folder])
											if (!saved) {
												report('尚无已保存项目。')
												return
											}
											if (hasProjectDraft(active.folder)) {
												report('请先应用或取消尚未应用的输入。')
												return
											}
											try {
												const project = folders[active.folder].project
												const result = project.replace({
													baseRevision: project.revision,
													files: JSON.parse(saved),
												})
												report(
													result.ok
														? '已从保存的源码重新打开。'
														: result.issues.map((issue) => issue.message).join('\n'),
												)
											} catch (error) {
												report(String(error))
											}
										}}
									>
										重新打开
									</button>
									<button
										type="button"
										onClick={() => {
											if (hasProjectDraft(active.folder)) {
												report('请先应用或取消尚未应用的输入。')
												return
											}
											const project = folders[active.folder].project
											const result = project.replace({
												baseRevision: project.revision,
												files: folders[active.folder].initialFiles,
											})
											report(
												result.ok
													? '已重置为示例源码。'
													: result.issues.map((issue) => issue.message).join('\n'),
											)
										}}
									>
										重置示例
									</button>
								</>
							)}
						</div>
					</header>
					{message && (
						<div className="source-status">
							<p role="status">{message}</p>
							<button type="button" aria-label="关闭提示" onClick={() => report('')}>
								×
							</button>
						</div>
					)}
					<DocumentStatus />
					<div className="workspace-layout">
						<Workbench
							workbench={workbench}
							empty={<p>从左侧打开文件或章节。</p>}
							native={{
								onRenderTab: (node, values) => {
									if (workbench.getDocument(node.getId())?.preview)
										values.content = <em>{values.content}</em>
								},
							}}
						/>
					</div>
				</main>
			</DocumentWorkspaceProvider>
		</WorkspaceContext.Provider>
	)
}
