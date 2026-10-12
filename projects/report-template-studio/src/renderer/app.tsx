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
import { Workbench } from '@worksplit/react'
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
import { WorkspaceContext } from './workspace-context'
import { useWorkspaceState } from './workspace'
import { StudioSession } from './workbench-session'
import { Explorer } from './explorer'
import { WorkspaceSearch } from './workspace-search'
function ProjectWorkspace({
	session,
	onSwitch,
}: {
	session: StudioSession
	onSwitch(error?: unknown): void
}) {
	const { workspace, workbench, project } = session
	useWorkspaceState(workspace)
	const [explorerVisible, setExplorerVisible] = useState(true)
	const [sidebar, setSidebar] = useState<'explorer' | 'search'>('explorer')
	const [busy, setBusy] = useState(false)
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
	const lifecycle = useRef({ active: false })
	useEffect(() => {
		const current = lifecycle.current
		current.active = true
		void session.start().catch((cause) => {
			if (current.active) session.report(cause)
		})
		const unload = (event: BeforeUnloadEvent) => {
			if (workspace.isDirty()) {
				event.preventDefault()
				event.returnValue = ''
			}
		}
		window.addEventListener('beforeunload', unload)
		return () => {
			current.active = false
			window.removeEventListener('beforeunload', unload)
			queueMicrotask(() => {
				if (!current.active)
					void session
						.dispose()
						.catch((cause) => console.error('Studio project cleanup failed', cause))
			})
		}
	}, [session, workspace])
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
	const switchProject = async () => {
		if (!(await session.closeDocuments())) return
		try {
			await session.dispose()
			onSwitch()
		} catch (error) {
			// The project has already shut down; report cleanup failure on the home screen.
			onSwitch(error)
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
								onClick={() => run(() => session.exportProject())}
							>
								导出工作区 ZIP
							</Menu.Item>
							<Menu.Divider />
							<Menu.Label>AI 助手</Menu.Label>
							<Menu.Item
								leftSection={<IconRobot size={16} />}
								onClick={() => run(() => session.showAssistant())}
							>
								显示 AI 助手
							</Menu.Item>
							<Menu.Item
								leftSection={<IconLayoutBottombar size={16} />}
								onClick={() => run(() => session.showAssistant('bottom'))}
							>
								AI 助手停靠到底部
							</Menu.Item>
							<Menu.Item
								leftSection={<IconLayoutSidebarRight size={16} />}
								onClick={() => run(() => session.showAssistant('right'))}
							>
								AI 助手停靠到右侧
							</Menu.Item>
							<Menu.Divider />
							<Menu.Item
								leftSection={<IconX size={16} />}
								onClick={() => run(() => session.closeAssistant())}
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
								onClick={() => run(() => session.showAssistant())}
							>
								<IconRobot size={21} />
							</ActionIcon>
						</Tooltip>
					</nav>
					<Explorer
						workspace={workspace}
						openFile={(path) => session.open('file', path)}
						openReport={(path) => session.openReport(path)}
						mutate={(path, to, action) => session.mutate(path, to, action)}
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
									await session.open('file', match.path)
								})
							}
						/>
					</aside>
					<div className="workbench-column">
						{(workspace.error || workspace.tree?.configError) && (
							<Alert
								color="red"
								withCloseButton
								onClose={() => {
									workspace.error = ''
									workspace.emit()
								}}
							>
								{workspace.error || workspace.tree?.configError}
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
export function App() {
	const [projects, setProjects] = useState<ProjectSummary[]>([])
	const [recentMenu, setRecentMenu] = useState<string | null>(null)
	const [session, setSession] = useState<StudioSession | null>(null)
	const openProject = (project: ProjectSummary) => setSession(new StudioSession(project))
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
	if (session)
		return (
			<ProjectWorkspace
				key={session.project.id}
				session={session}
				onSwitch={(cause) => {
					setSession(null)
					setError(cause ? String(cause) : '')
					void refresh().catch((refreshError) => setError(String(refreshError)))
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
										openProject(created)
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
									openProject(selected)
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
								openProject(imported)
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
							onClick={() => openProject(item)}
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
