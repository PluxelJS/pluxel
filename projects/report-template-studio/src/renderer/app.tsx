import { useEffect, useRef, useState } from 'react'
import {
	Alert,
	Badge,
	Button,
	Group,
	Menu,
	ActionIcon,
	Tooltip,
	Paper,
	Stack,
	Text,
	TextInput,
	UnstyledButton,
} from '@mantine/core'
import {
	createRootRoute,
	createRoute,
	createRouter,
	defaultParseSearch,
	Outlet,
} from '@tanstack/react-router'
import { createWorkbench, Workbench } from '@worksplit/react'
import { Actions, DockLocation } from 'flexlayout-react'
import {
	IconFileText,
	IconFolder,
	IconDots,
	IconDownload,
	IconFolderOpen,
	IconTrash,
	IconLayoutSidebar,
	IconFiles,
	IconSearch,
	IconX,
	IconRobot,
	IconLayoutBottombar,
	IconLayoutSidebarRight,
} from '@tabler/icons-react'
import type { ProjectSummary } from '../shared/contracts'
import { api } from './api'
import { FilePane, FormPane, PreviewPane } from './panes'
import { WorkspaceContext } from './workspace-context'
import { WorkspaceController, useWorkspaceState } from './workspace'
import { AssistantPanel } from './assistant'
import { Explorer } from './explorer'
import { WorkspaceSearch } from './workspace-search'
import {
	assistantTab,
	createStudioLayout,
	documentTarget,
	editorGroups,
	findTool,
	studioLayoutGlobal,
} from './workbench-layout'

const rootRoute = createRootRoute({ component: Outlet })
const fileRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/file',
	validateSearch: (search: Record<string, unknown>) => ({ path: String(search.path ?? '') }),
	staticData: { worksplit: { title: '文件', identitySearch: ['path'] } },
	component: function FileRoute() {
		return <FilePane path={fileRoute.useSearch().path} />
	},
})
const formRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/form',
	validateSearch: (search: Record<string, unknown>) => ({ entry: String(search.entry ?? '') }),
	staticData: { worksplit: { title: '表单', identitySearch: ['entry'] } },
	component: function FormRoute() {
		return <FormPane entry={formRoute.useSearch().entry} />
	},
})
const previewRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/preview',
	validateSearch: (search: Record<string, unknown>) => ({ entry: String(search.entry ?? '') }),
	staticData: { worksplit: { title: '预览', identitySearch: ['entry'] } },
	component: function PreviewRoute() {
		return <PreviewPane entry={previewRoute.useSearch().entry} />
	},
})
const routeTree = rootRoute.addChildren([fileRoute, formRoute, previewRoute])
function ProjectWorkspace({ project, onSwitch }: { project: ProjectSummary; onSwitch(): void }) {
	const [workspace] = useState(() => new WorkspaceController(project))
	useWorkspaceState(workspace)
	const [explorerVisible, setExplorerVisible] = useState(true)
	const [sidebar, setSidebar] = useState<'explorer' | 'search'>('explorer')
	const [busy, setBusy] = useState(false)
	const [workbench] = useState(() =>
		createWorkbench({
			workspaceId: project.id,
			home: '/',
			homeMode: 'empty',
			createRouter: (history) => createRouter({ routeTree, history }),
			layout: createStudioLayout(),
			tools: [{ id: 'assistant', render: () => <AssistantTool workspace={workspace} /> }],
			onIssue: ({ error }) => {
				workspace.error = String(error)
				workspace.emit()
			},
		}),
	)
	useEffect(() => {
		// Fast Refresh retains the actual Worksplit instance. Apply current native
		// defaults through its coordinator and reclaim existing empty split groups.
		void (async () => {
			await workbench.dispatch(Actions.updateModelAttributes(studioLayoutGlobal))
			if (findTool(workbench.getLayout(), 'assistant'))
				await workbench.dispatch(
					Actions.updateNodeAttributes('assistant', {
						enableClose: true,
						enableDrag: true,
						enableScrollbars: false,
					}),
				)
			const groups = editorGroups(workbench.getLayout().layout)
			if (groups.length > 1)
				for (const group of groups)
					if (group.id && !group.children?.length)
						await workbench.dispatch(Actions.deleteTabset(group.id))
		})().catch((cause) => {
			workspace.error = String(cause)
			workspace.emit()
		})
	}, [workspace, workbench])
	const showSidebar = (view: 'explorer' | 'search') => {
		setSidebar(view)
		setExplorerVisible(true)
		requestAnimationFrame(() => {
			const label = view === 'explorer' ? '筛选文件和文件夹' : '搜索代码'
			const input = document.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)
			input?.focus()
			input?.select()
		})
	}
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (
				event.key === 'Escape' &&
				event.target instanceof Element &&
				event.target.closest('.workspace-code-search')
			) {
				event.preventDefault()
				showSidebar('explorer')
				return
			}
			if (!(event.ctrlKey || event.metaKey) || event.altKey) return
			const key = event.key.toLowerCase()
			if (event.shiftKey && (key === 'f' || key === 'e')) {
				event.preventDefault()
				event.stopPropagation()
				showSidebar(key === 'f' ? 'search' : 'explorer')
			} else if (!event.shiftKey && key === 'p') {
				event.preventDefault()
				event.stopPropagation()
				showSidebar('explorer')
			}
		}
		window.addEventListener('keydown', onKey, true)
		return () => window.removeEventListener('keydown', onKey, true)
	}, [])
	// Fast Refresh replays effects while retaining state. Keep imperative resources
	// alive through that replay, but release them after a real project unmount.
	const lifecycle = useRef({ active: false, started: false })
	useEffect(() => {
		const current = lifecycle.current
		current.active = true
		if (!current.started) {
			current.started = true
			workspace.start()
			void (async () => {
				await workbench.start('/')
				await workspace.refresh()
				if (!current.active) return
				const first = workspace.tree?.documents[0]
				if (!first) return
				await open('form', first.entry)
				if (current.active) await open('preview', first.entry)
			})().catch((cause) => {
				if (current.active) {
					workspace.error = String(cause)
					workspace.emit()
				}
			})
		}
		const unload = (event: BeforeUnloadEvent) => {
			if (
				[...workspace.files.values()].some((file) => file.dirty) ||
				[...workspace.documents.values()].some((document) => document.inputDirty)
			) {
				event.preventDefault()
				event.returnValue = ''
			}
		}
		window.addEventListener('beforeunload', unload)
		return () => {
			current.active = false
			window.removeEventListener('beforeunload', unload)
			queueMicrotask(() => {
				if (current.active) return
				workspace.dispose()
				void workbench.dispose()
			})
		}
	}, [workspace, workbench])
	const run = (task: () => Promise<unknown>) => {
		setBusy(true)
		workspace.error = ''
		void task()
			.catch((cause) => {
				workspace.error = String(cause)
				workspace.emit()
			})
			.finally(() => setBusy(false))
	}
	const open = async (kind: 'file' | 'form' | 'preview', path: string) => {
		const target = documentTarget(
			kind,
			workbench.getLayout(),
			workbench.getDocuments(),
			workbench.getEditingContext().activeGroupId,
		)
		const active = workbench.getActiveDocument()
		const preserveFocus = Boolean(
			active && (target.location !== undefined || target.target !== active.containerId),
		)
		const result =
			kind === 'file'
				? await workbench.open({ to: '/file', search: { path } }, target)
				: kind === 'form'
					? await workbench.open({ to: '/form', search: { entry: path } }, target)
					: await workbench.open(
							{ to: '/preview', search: { entry: path } },
							{ ...target, preserveFocus },
						)
		if (result.status === 'failed') throw result.error
		if (result.status === 'committed')
			await workbench.dispatch(
				Actions.renameTab(
					result.document.id,
					`${kind === 'preview' ? '预览 · ' : ''}${kind === 'file' ? path.split('/').at(-1) : (workspace.documents.get(path)?.result?.name ?? path.split('/').at(-1)?.replace(/\.ts$/, ''))}`,
				),
			)
	}
	const showAssistant = async (dock?: 'bottom' | 'right') => {
		const layout = workbench.getLayout()
		let tool = findTool(layout, 'assistant')
		const destination = dock ?? 'bottom'
		if (dock || !tool) {
			if (!layout.borders?.some((border) => border.location === destination))
				throw new Error('请重新打开项目以启用右侧停靠布局')
			const action = tool
				? Actions.moveNode('assistant', `border_${destination}`, DockLocation.CENTER, -1, true)
				: Actions.addTab(
						{ ...assistantTab },
						`border_${destination}`,
						DockLocation.CENTER,
						-1,
						true,
					)
			const result = await workbench.dispatch(action)
			if (result.status === 'failed') throw result.error
			if (result.status !== 'applied') return
			tool = findTool(workbench.getLayout(), 'assistant')
		}
		if (!tool) return
		if (tool.group?.opened === false && tool.group.id) {
			await workbench.dispatch(Actions.updateNodeAttributes(tool.group.id, { opened: true }))
			tool = findTool(workbench.getLayout(), 'assistant')
		}
		if (!tool) return
		if ('location' in tool.container && tool.container.show === false)
			await workbench.dispatch(
				Actions.updateNodeAttributes(`border_${tool.container.location}`, { show: true }),
			)
		const maximized = editorGroups(workbench.getLayout().layout).find((group) => group.maximized)
		const containerId =
			'location' in tool.container ? `border_${tool.container.location}` : tool.container.id
		if (maximized?.id && maximized.id !== containerId)
			await workbench.dispatch(Actions.maximizeToggle(maximized.id))
		if (!tool.selected) await workbench.dispatch(Actions.selectTab('assistant'))
	}
	const switchProject = async () => {
		for (const document of workbench.getDocuments()) {
			const result = await workbench.close(document.id)
			if (result.status !== 'closed') return
		}
		onSwitch()
	}
	const openReport = async (path: string) => {
		workspace.preferPreview(path)
		await open('form', path)
		await open('preview', path)
	}
	useEffect(
		() => workspace.connectSourceNavigation((path) => open('file', path)),
		[workspace, workbench],
	)
	const exportProject = async () => {
		for (const path of workspace.files.keys()) await workspace.save(path)
		for (const entry of workspace.documents.keys()) await workspace.saveInput(entry)
		if (
			[...workspace.files.values()].some((file) => file.dirty) ||
			[...workspace.documents.values()].some((document) => document.inputDirty)
		)
			throw new Error('请先解决未保存的修改再导出')
		const bytes = await api.exportWorkspace({ projectId: project.id })
		await window.studio.saveFile({ suggestedName: `${project.name}.zip`, bytes })
	}
	const mutate = async (
		path: string,
		to: string | undefined,
		action: (version: string) => Promise<unknown>,
	) => {
		const report = workspace.tree?.documents.find(
			(document) => document.entry === `${path}/${path.split('/').at(-1)}.ts`,
		)
		const affected = (candidate: string) => candidate === path || candidate.startsWith(path + '/')
		for (const file of workspace.files.keys()) if (affected(file)) await workspace.save(file)
		for (const entry of workspace.documents.keys())
			if (affected(entry)) await workspace.saveInput(entry)
		if (
			[...workspace.files].some(([key, file]) => affected(key) && file.dirty) ||
			[...workspace.documents].some(([key, document]) => affected(key) && document.inputDirty)
		)
			throw new Error('请先解决此路径内未保存的修改')
		const tabs = workbench.getDocuments().flatMap((document) => {
			const url = new URL(document.href, window.location.href)
			const search = defaultParseSearch(url.search) as Record<string, unknown>
			const value = typeof search.path === 'string' ? search.path : search.entry
			return typeof value === 'string' && affected(value)
				? [
						{
							id: document.id,
							kind: (url.pathname === '/file'
								? 'file'
								: url.pathname === '/form'
									? 'form'
									: 'preview') as 'file' | 'form' | 'preview',
							path: value,
						},
					]
				: []
		})
		for (const tab of tabs) {
			const closed = await workbench.close(tab.id)
			if (closed.status !== 'closed') throw new Error('仍有标签未关闭，操作已取消')
		}
		try {
			await workspace.refresh()
			const item = workspace.tree?.entries.find((candidate) => candidate.path === path)
			if (!item) throw new Error('路径已不存在，请刷新文件树')
			await action(item.version)
		} catch (error) {
			for (const tab of tabs) await open(tab.kind, tab.path)
			throw error
		}

		for (const entry of workspace.documents.keys())
			if (affected(entry)) workspace.documents.delete(entry)
		await workspace.refresh()
		if (to)
			for (const tab of tabs) {
				const next =
					report?.entry === tab.path
						? `${to}/${to.split('/').at(-1)}.ts`
						: to + tab.path.slice(path.length)
				await open(tab.kind, next)
			}
	}
	return (
		<WorkspaceContext.Provider value={workspace}>
			<div className="studio-shell">
				<header className="studio-header">
					<Group gap="sm">
						<Tooltip label={explorerVisible ? '隐藏侧栏' : '显示侧栏'}>
							<ActionIcon
								variant="subtle"
								color="gray"
								aria-label="切换侧栏"
								onClick={() => setExplorerVisible((value) => !value)}
							>
								<IconLayoutSidebar size={19} />
							</ActionIcon>
						</Tooltip>
						<IconFolder size={20} />
						<Text fw={600} size="sm" title={project.root}>
							{workspace.tree?.config.name ?? project.name}
						</Text>
					</Group>
					<Menu position="bottom-end" shadow="md">
						<Menu.Target>
							<Button
								size="xs"
								variant="subtle"
								color="gray"
								rightSection={<IconDots size={16} />}
								disabled={busy}
							>
								项目
							</Button>
						</Menu.Target>
						<Menu.Dropdown>
							<Menu.Item
								leftSection={<IconFolderOpen size={16} />}
								onClick={() =>
									run(() => window.studio.revealInFileManager({ projectId: project.id, path: '' }))
								}
							>
								在系统文件管理器中打开项目目录
							</Menu.Item>
							<Menu.Item
								leftSection={<IconFolderOpen size={16} />}
								onClick={() => run(switchProject)}
							>
								切换项目
							</Menu.Item>
							<Menu.Item
								leftSection={<IconDownload size={16} />}
								onClick={() => run(exportProject)}
							>
								导出工作区 ZIP
							</Menu.Item>
							<Menu.Divider />
							<Menu.Label>AI 助手</Menu.Label>
							<Menu.Item leftSection={<IconRobot size={16} />} onClick={() => run(showAssistant)}>
								显示 AI 助手
							</Menu.Item>
							<Menu.Item
								leftSection={<IconLayoutBottombar size={16} />}
								onClick={() => run(() => showAssistant('bottom'))}
							>
								AI 助手停靠到底部
							</Menu.Item>
							<Menu.Item
								leftSection={<IconLayoutSidebarRight size={16} />}
								onClick={() => run(() => showAssistant('right'))}
							>
								AI 助手停靠到右侧
							</Menu.Item>
							<Menu.Divider />
							<Menu.Item
								leftSection={<IconX size={16} />}
								onClick={() =>
									run(async () => {
										const result = await workbench.close('assistant')
										if (result.status === 'failed') throw result.error
									})
								}
							>
								关闭 AI 助手
							</Menu.Item>
							<Menu.Divider />
							<Menu.Label title={project.root}>{project.root}</Menu.Label>
						</Menu.Dropdown>
					</Menu>
				</header>
				<div className="studio-body">
					<nav className="studio-activity-bar" aria-label="工作区视图">
						<Tooltip label="资源管理器 · Ctrl/⌘ Shift E" position="right">
							<ActionIcon
								size={36}
								variant="subtle"
								color={explorerVisible && sidebar === 'explorer' ? 'teal' : 'gray'}
								aria-label="资源管理器"
								aria-pressed={explorerVisible && sidebar === 'explorer'}
								onClick={() => showSidebar('explorer')}
							>
								<IconFiles size={21} />
							</ActionIcon>
						</Tooltip>
						<Tooltip label="搜索代码 · Ctrl/⌘ Shift F" position="right">
							<ActionIcon
								size={36}
								variant="subtle"
								color={explorerVisible && sidebar === 'search' ? 'teal' : 'gray'}
								aria-label="搜索代码视图"
								aria-pressed={explorerVisible && sidebar === 'search'}
								onClick={() => showSidebar('search')}
							>
								<IconSearch size={21} />
							</ActionIcon>
						</Tooltip>
						<Tooltip label="AI 助手" position="right">
							<ActionIcon
								size={36}
								variant="subtle"
								color="gray"
								aria-label="显示 AI 助手"
								onClick={() => run(showAssistant)}
							>
								<IconRobot size={21} />
							</ActionIcon>
						</Tooltip>
					</nav>
					<Explorer
						workspace={workspace}
						openFile={(path) => open('file', path)}
						openReport={openReport}
						mutate={mutate}
						hidden={!explorerVisible || sidebar !== 'explorer'}
					/>
					<aside
						className="explorer workspace-code-search"
						aria-label="代码搜索"
						style={!explorerVisible || sidebar !== 'search' ? { display: 'none' } : undefined}
					>
						<Group justify="space-between" className="explorer-heading">
							<Text size="xs" fw={600}>
								搜索代码
							</Text>
							<ActionIcon
								variant="subtle"
								color="gray"
								aria-label="关闭代码搜索侧栏"
								onClick={() => setExplorerVisible(false)}
							>
								<IconX size={17} />
							</ActionIcon>
						</Group>
						<WorkspaceSearch
							workspace={workspace}
							active={explorerVisible && sidebar === 'search'}
							open={(match) =>
								run(async () => {
									if (match.line) {
										workspace.location = {
											path: match.path,
											line: match.line,
											column: match.column ?? 1,
										}
										workspace.emit()
									}
									await open('file', match.path)
								})
							}
						/>
					</aside>
					<div className="workbench-column">
						{workspace.error && (
							<Alert
								color="red"
								withCloseButton
								onClose={() => {
									workspace.error = ''
									workspace.emit()
								}}
							>
								{workspace.error}
							</Alert>
						)}
						<Workbench
							workbench={workbench}
							className="studio-workbench"
							native={{ realtimeResize: true }}
							empty={
								<div className="welcome">
									<IconFileText size={32} />
									<Text size="sm" c="dimmed">
										点击左侧报表开始填写，或右键新建报表
									</Text>
								</div>
							}
						/>
					</div>
				</div>
				<footer className="status-bar">
					<span>
						{[...workspace.files.values()].some((file) => file.error && file.dirty) ||
						[...workspace.documents.values()].some((document) => document.inputError)
							? '有修改未保存，请检查错误'
							: [...workspace.files.values()].some((file) => file.dirty) ||
								  [...workspace.documents.values()].some((document) => document.inputDirty)
								? '正在保存修改…'
								: '修改自动保存在本机'}
					</span>
					<span>{workspace.tree?.documents.length ?? 0} 个报表</span>
				</footer>
			</div>
		</WorkspaceContext.Provider>
	)
}
function AssistantTool({ workspace }: { workspace: WorkspaceController }) {
	useWorkspaceState(workspace)
	return (
		<AssistantPanel
			projectId={workspace.project.id}
			uiState={workspace.assistantState}
			entries={workspace.tree?.entries ?? []}
			onChanged={() => void workspace.refresh()}
		/>
	)
}
export function App() {
	const [projects, setProjects] = useState<ProjectSummary[]>([])
	const [recentMenu, setRecentMenu] = useState<string | null>(null)
	const [project, setProject] = useState<ProjectSummary | null>(null)
	const [name, setName] = useState('新的报表项目')
	const [error, setError] = useState('')
	const [busy, setBusy] = useState(false)
	const refresh = async () => setProjects(await api.listProjects())
	useEffect(() => {
		void refresh().catch((cause) => setError(String(cause)))
	}, [])
	const run = (task: () => Promise<unknown>) => {
		setBusy(true)
		setError('')
		void task()
			.catch((cause) => setError(String(cause)))
			.finally(() => setBusy(false))
	}
	if (project)
		return (
			<ProjectWorkspace
				key={project.id}
				project={project}
				onSwitch={() => {
					setProject(null)
					void refresh()
				}}
			/>
		)
	return (
		<div className="project-home">
			<Stack w="min(640px, 94vw)" gap="lg">
				<Group>
					<IconFolder size={36} />
					<div>
						<Text size="xl" fw={700}>
							Typst 工作区
						</Text>
						<Text size="sm" c="dimmed">
							打开本地目录，用文件、表单与 AI 一起制作报表
						</Text>
					</div>
				</Group>
				{error && <Alert color="red">{error}</Alert>}
				<Paper withBorder radius="md" p="lg">
					<Stack gap="md">
						<Group justify="space-between">
							<Text fw={600} size="lg">
								财务报表 Starter
							</Text>
							<Badge variant="light">内置模板</Badge>
						</Group>
						<Text size="sm">
							以默认字体和共享主题开始，包含银行询证函、银行账户余额汇总表及带图片、公式和多页表格的季度经营分析，表单已填入演示默认值。
						</Text>
						<Text size="sm" c="dimmed">
							每次新建都是独立项目，可以自由修改模板、主题和字体。
						</Text>
						<Group align="flex-end">
							<TextInput
								aria-label="项目名称"
								label="项目名称"
								value={name}
								onChange={(event) => setName(event.currentTarget.value)}
								style={{ flex: 1 }}
							/>
							<Button
								disabled={busy || !name.trim()}
								onClick={() =>
									run(async () => {
										const created = await api.createProject({ name })
										await refresh()
										setProject(created)
									})
								}
							>
								新建项目
							</Button>
						</Group>
						<Text size="xs" c="dimmed">
							项目和填写数据自动保存在本机应用数据目录。关闭应用或重新运行 dev
							后，可从下方“最近项目”继续。
						</Text>
					</Stack>
				</Paper>
				<Group>
					<Button
						variant="default"
						disabled={busy}
						onClick={() =>
							run(async () => {
								const selected = await window.studio.openProject()
								if (selected) {
									await refresh()
									setProject(selected)
								}
							})
						}
					>
						打开本地目录…
					</Button>
					<Button
						variant="default"
						disabled={busy}
						onClick={() =>
							run(async () => {
								const input = await window.studio.importFile({ kind: 'workspace' })
								if (!input) return
								const imported = await api.importWorkspace({ bytes: input.bytes })
								await refresh()
								setProject(imported)
							})
						}
					>
						导入工作区 ZIP…
					</Button>
				</Group>
				<Text fw={600}>最近项目</Text>
				{projects.length === 0 && (
					<Text size="sm" c="dimmed">
						还没有项目。使用上方 Starter 新建，或打开已有目录。
					</Text>
				)}
				{projects.map((item) => (
					<Group
						key={item.id}
						justify="space-between"
						className="recent-project"
						onContextMenu={(event) => {
							event.preventDefault()
							setRecentMenu(item.id)
						}}
					>
						<UnstyledButton
							disabled={busy}
							onClick={() => setProject(item)}
							style={{ flex: 1, minWidth: 0 }}
						>
							<Text fw={550}>{item.name}</Text>
							<Text size="xs" c="dimmed" truncate>
								{item.root}
							</Text>
						</UnstyledButton>
						<Menu
							opened={recentMenu === item.id}
							onChange={(opened) => setRecentMenu(opened ? item.id : null)}
							position="bottom-end"
							shadow="md"
						>
							<Menu.Target>
								<ActionIcon variant="subtle" color="gray" aria-label={`项目操作 ${item.name}`}>
									<IconDots size={17} />
								</ActionIcon>
							</Menu.Target>
							<Menu.Dropdown>
								<Menu.Item
									color="red"
									leftSection={<IconTrash size={15} />}
									disabled={busy}
									onClick={() =>
										run(async () => {
											await api.forgetProject({ projectId: item.id })
											await refresh()
										})
									}
								>
									从最近项目移除
								</Menu.Item>
							</Menu.Dropdown>
						</Menu>
					</Group>
				))}
			</Stack>
		</div>
	)
}
