import { useMemo, useRef, useState } from 'react'
import {
	ActionIcon,
	Alert,
	Button,
	Group,
	Menu,
	Modal,
	Text,
	TextInput,
	UnstyledButton,
} from '@mantine/core'
import {
	IconChevronDown,
	IconChevronRight,
	IconCode,
	IconDots,
	IconFile,
	IconFilePlus,
	IconFolderOpen,
	IconFolderPlus,
	IconForms,
	IconPencil,
	IconTrash,
	IconUpload,
	IconSearch,
	IconX,
} from '@tabler/icons-react'
import type { FileEntry } from '../shared/contracts'
import { api } from './api'
import { WorkspaceController, useWorkspaceState } from './workspace'

const parentPath = (path: string) => path.split('/').slice(0, -1).join('/')
const leaf = (path: string) => path.split('/').at(-1) ?? path
const contains = (parent: string, path: string) => path === parent || path.startsWith(parent + '/')
type Operation = 'file' | 'directory' | 'report' | 'rename' | 'delete'
export function Explorer({
	workspace,
	openFile,
	openReport,
	mutate,
	hidden = false,
}: {
	workspace: WorkspaceController
	openFile(path: string): Promise<unknown>
	openReport(path: string): Promise<void>
	mutate(
		path: string,
		to: string | undefined,
		action: (version: string) => Promise<unknown>,
	): Promise<void>
	hidden?: boolean
}) {
	useWorkspaceState(workspace)
	const [selection, setSelection] = useState('')
	const [collapsed, setCollapsed] = useState(new Set(['.agents', '共享/字体']))
	const [filter, setFilter] = useState('')
	const [filterCollapsed, setFilterCollapsed] = useState(new Set<string>())
	const query = filter.trim().toLowerCase()
	const folded = query ? filterCollapsed : collapsed
	const [menu, setMenu] = useState<{ x: number; y: number; path: string } | null>(null)
	const [operation, setOperation] = useState<{
		kind: Operation
		path: string
	} | null>(null)
	const [name, setName] = useState('')
	const [error, setError] = useState('')
	const [busy, setBusy] = useState(false)
	const treeRef = useRef<HTMLDivElement>(null)
	const entries = workspace.tree?.entries ?? []
	const reports = workspace.tree?.documents ?? []
	const byPath = useMemo(() => new Map(entries.map((item) => [item.path, item])), [entries])
	const filtered = useMemo(() => {
		if (!query) return undefined
		const visible = new Set<string>()
		let matches = 0
		for (const entry of entries) {
			if (!entry.path.toLowerCase().includes(query)) continue
			matches++
			for (let path = entry.path; path; path = parentPath(path)) visible.add(path)
		}
		return { visible, matches }
	}, [entries, query])
	const byReport = useMemo(
		() =>
			new Map(
				reports.flatMap(
					(report) =>
						[
							[report.entry, report],
							[parentPath(report.entry), report],
						] as const,
				),
			),
		[reports],
	)
	const children = useMemo(() => {
		const result = new Map<string, FileEntry[]>()
		for (const entry of entries) {
			const parent = parentPath(entry.path)
			const group = result.get(parent) ?? []
			group.push(entry)
			result.set(parent, group)
		}
		for (const group of result.values())
			group.sort((a, b) =>
				a.kind === b.kind ? a.path.localeCompare(b.path) : a.kind === 'directory' ? -1 : 1,
			)
		return result
	}, [entries])
	const run = async (task: () => Promise<unknown>) => {
		setBusy(true)
		setError('')
		try {
			await task()
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause))
		} finally {
			setBusy(false)
		}
	}
	const toggle = (path: string, expand?: boolean) =>
		(query ? setFilterCollapsed : setCollapsed)((current) => {
			const next = new Set(current)
			if (expand ?? next.has(path)) next.delete(path)
			else next.add(path)
			return next
		})
	const reveal = (path: string) => {
		setFilter('')
		setSelection(path)
		setCollapsed((current) => new Set([...current].filter((item) => !contains(item, path))))
	}
	const activate = (item: FileEntry) => {
		setSelection(item.path)
		const report = byReport.get(item.path)
		if (report) {
			if (item.kind === 'directory') toggle(item.path, true)
			void run(() => openReport(report.entry))
		} else if (item.kind === 'directory') toggle(item.path)
		else if (!item.binary) void run(() => openFile(item.path))
	}
	const begin = (kind: Operation, path: string) => {
		if (busy) return
		setMenu(null)
		setError('')
		// A report is renamed through its directory, keeping its matching TS entry together.
		const report = byReport.get(path)
		const target = kind === 'rename' && report ? parentPath(report.entry) : path
		const item = byPath.get(target)
		setOperation({ kind, path: target })
		const parent = item?.kind === 'directory' ? target : parentPath(target)
		setName(kind === 'rename' ? target : parent ? `${parent}/` : '')
	}
	const importAsset = (path: string) => {
		setMenu(null)
		void run(async () => {
			const asset = await window.studio.importFile({ kind: 'asset' })
			if (!asset) return
			const directory = byPath.get(path)?.kind === 'directory' ? path : parentPath(path)
			const destination = directory ? `${directory}/${asset.name}` : asset.name
			await api.putAsset({ projectId: workspace.project.id, path: destination, bytes: asset.bytes })
			await workspace.refresh()
			reveal(destination)
		})
	}
	const submit = async () => {
		if (!operation) return
		const { kind, path } = operation
		const destination = name.trim()
		await run(async () => {
			if (kind === 'delete')
				await mutate(path, undefined, (version) =>
					api.remove({ projectId: workspace.project.id, path, expectedVersion: version }),
				)
			else if (kind === 'rename')
				await mutate(path, destination, (version) =>
					api.rename({
						projectId: workspace.project.id,
						path,
						to: destination,
						expectedVersion: version,
					}),
				)
			else if (kind === 'report') {
				const report = await api.createReport({
					projectId: workspace.project.id,
					path: destination,
				})
				await workspace.refresh()
				reveal(report.entry)
				await openReport(report.entry)
			} else {
				if (kind === 'directory')
					await api.mkdir({ projectId: workspace.project.id, path: destination })
				else
					await api.writeFile({
						projectId: workspace.project.id,
						path: destination,
						content: '',
						expectedVersion: null,
					})
			}
			await workspace.refresh()
			if (kind === 'file') await openFile(destination)
			if (kind !== 'report') reveal(kind === 'delete' ? parentPath(path) : destination)
			setOperation(null)
		})
	}
	const menuItems = (path: string) => (
		<>
			{byReport.has(path) && (
				<>
					<Menu.Item
						disabled={busy}
						leftSection={<IconForms size={15} />}
						onClick={() => {
							setMenu(null)
							void run(() => openReport(byReport.get(path)!.entry))
						}}
					>
						打开报表
					</Menu.Item>
					<Menu.Item
						disabled={busy}
						leftSection={<IconCode size={15} />}
						onClick={() => {
							setMenu(null)
							void run(() => openFile(byReport.get(path)!.entry))
						}}
					>
						打开入口源码
					</Menu.Item>
					<Menu.Divider />
				</>
			)}
			<Menu.Item
				disabled={busy}
				leftSection={<IconFolderOpen size={15} />}
				onClick={() => {
					setMenu(null)
					void run(() =>
						window.studio.revealInFileManager({ projectId: workspace.project.id, path }),
					)
				}}
			>
				{path ? '在系统文件管理器中显示' : '打开项目目录'}
			</Menu.Item>
			<Menu.Divider />
			<Menu.Item
				disabled={busy}
				leftSection={<IconForms size={15} />}
				onClick={() => begin('report', path)}
			>
				新建报表…
			</Menu.Item>
			<Menu.Item
				disabled={busy}
				leftSection={<IconFilePlus size={15} />}
				onClick={() => begin('file', path)}
			>
				新建文件…
			</Menu.Item>
			<Menu.Item
				disabled={busy}
				leftSection={<IconFolderPlus size={15} />}
				onClick={() => begin('directory', path)}
			>
				新建文件夹…
			</Menu.Item>
			<Menu.Item
				disabled={busy}
				leftSection={<IconUpload size={15} />}
				onClick={() => importAsset(path)}
			>
				导入文件…
			</Menu.Item>
			{path && (
				<>
					<Menu.Divider />
					<Menu.Item
						disabled={busy}
						leftSection={<IconPencil size={15} />}
						rightSection={
							<Text size="xs" c="dimmed">
								F2
							</Text>
						}
						onClick={() => begin('rename', path)}
					>
						{byReport.has(path) ? '重命名报表…' : '重命名 / 移动…'}
					</Menu.Item>
					<Menu.Item
						disabled={busy}
						color="red"
						leftSection={<IconTrash size={15} />}
						rightSection={
							<Text size="xs" c="dimmed">
								Del
							</Text>
						}
						onClick={() => begin('delete', path)}
					>
						删除…
					</Menu.Item>
				</>
			)}
		</>
	)
	const renderTree = (parent = ''): React.ReactNode =>
		children
			.get(parent)
			?.filter((item) => !filtered || filtered.visible.has(item.path))
			.map((item) => {
				const report = byReport.get(item.path)
				const document = report && workspace.documents.get(report.entry)
				const directory = item.kind === 'directory'
				return (
					<div key={item.path} role="none">
						<UnstyledButton
							role="treeitem"
							aria-expanded={directory ? !folded.has(item.path) : undefined}
							aria-selected={selection === item.path}
							tabIndex={
								selection === item.path ||
								(!selection &&
									item ===
										children
											.get('')
											?.find((entry) => !filtered || filtered.visible.has(entry.path)))
									? 0
									: -1
							}
							data-path={item.path}
							aria-label={`${report ? '报表' : directory ? '目录' : '文件'} ${item.path}`}
							title={document?.error ?? item.path}
							className={`explorer-file ${selection === item.path ? 'is-active' : ''} ${report ? 'is-report' : ''}`}
							style={{ paddingLeft: 8 + (item.path.split('/').length - 1) * 14 }}
							onFocus={() => setSelection(item.path)}
							onClick={(event) => {
								if (directory && (event.target as Element).closest('.explorer-chevron')) {
									setSelection(item.path)
									toggle(item.path)
								} else activate(item)
							}}
							onContextMenu={(event) => {
								event.preventDefault()
								event.stopPropagation()
								setSelection(item.path)
								setMenu({ x: event.clientX, y: event.clientY, path: item.path })
							}}
						>
							<span className="explorer-chevron">
								{directory ? (
									folded.has(item.path) ? (
										<IconChevronRight size={13} />
									) : (
										<IconChevronDown size={13} />
									)
								) : null}
							</span>
							{report ? (
								<IconForms size={15} />
							) : (
								<IconFile size={15} style={{ opacity: directory ? 0 : 0.7 }} />
							)}
							<Text size="xs" truncate style={{ flex: 1 }}>
								{leaf(item.path)}
							</Text>
							{document?.error ? (
								<span className="explorer-error" aria-label="报表存在错误">
									!
								</span>
							) : workspace.files.get(item.path)?.dirty ? (
								<span aria-label="未保存">●</span>
							) : null}
						</UnstyledButton>
						{directory && !folded.has(item.path) && <div role="group">{renderTree(item.path)}</div>}
					</div>
				)
			})
	const titles: Record<Operation, string> = {
		file: '新建文件',
		directory: '新建文件夹',
		report: '新建报表',
		rename: '重命名 / 移动',
		delete: '删除文件',
	}
	return (
		<aside
			className="explorer"
			aria-label="资源管理器"
			style={hidden ? { display: 'none' } : undefined}
		>
			<Group justify="space-between" className="explorer-heading">
				<Text size="xs" fw={600}>
					资源管理器
				</Text>
				<Menu position="bottom-end" shadow="md">
					<Menu.Target>
						<ActionIcon
							variant="subtle"
							color="gray"
							aria-label="文件操作"
							title="文件操作"
							disabled={busy}
						>
							<IconDots size={17} />
						</ActionIcon>
					</Menu.Target>
					<Menu.Dropdown>{menuItems(selection)}</Menu.Dropdown>
				</Menu>
			</Group>
			{error && !operation && (
				<Alert color="red" withCloseButton onClose={() => setError('')}>
					{error}
				</Alert>
			)}
			<div
				className="explorer-scroll"
				role="tree"
				tabIndex={-1}
				aria-label="项目文件"
				ref={treeRef}
				onContextMenu={(event) => {
					event.preventDefault()
					setSelection('')
					setMenu({ x: event.clientX, y: event.clientY, path: '' })
				}}
				onKeyDown={(event) => {
					if (busy || operation) return
					const item = byPath.get(selection)
					if (event.key === 'F2' && item) {
						event.preventDefault()
						begin('rename', selection)
					} else if (event.key === 'Delete' && item) {
						event.preventDefault()
						begin('delete', selection)
					} else if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
						event.preventDefault()
						const bounds = (event.target as HTMLElement).getBoundingClientRect()
						setMenu({ x: bounds.left + 20, y: bounds.bottom, path: selection })
					} else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
						event.preventDefault()
						const items = Array.from(
							treeRef.current?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? [],
						)
						const index = items.findIndex((node) => node.dataset.path === selection)
						items[
							Math.max(0, Math.min(items.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))
						]?.focus()
					} else if (event.key === 'ArrowRight' && item?.kind === 'directory') {
						event.preventDefault()
						toggle(item.path, true)
					} else if (event.key === 'ArrowLeft' && item) {
						event.preventDefault()
						if (item.kind === 'directory' && !folded.has(item.path)) toggle(item.path, false)
						else
							Array.from(treeRef.current?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? [])
								.find((node) => node.dataset.path === parentPath(item.path))
								?.focus()
					}
				}}
			>
				{renderTree()}
				{entries.length === 0 && (
					<Text c="dimmed" size="xs" p="md">
						右键新建报表，或导入文件开始。
					</Text>
				)}
				{filtered?.matches === 0 && (
					<Text c="dimmed" size="xs" p="md">
						没有匹配的文件或文件夹
					</Text>
				)}
			</div>
			<div className="explorer-filter">
				<TextInput
					size="xs"
					aria-label="筛选文件和文件夹"
					placeholder="筛选文件和文件夹…"
					title="Ctrl/⌘ P · Esc 清空"
					value={filter}
					maxLength={500}
					leftSection={<IconSearch size={14} />}
					rightSection={
						filter ? (
							<ActionIcon
								size="xs"
								variant="subtle"
								color="gray"
								aria-label="清空文件筛选"
								onClick={() => setFilter('')}
							>
								<IconX size={13} />
							</ActionIcon>
						) : undefined
					}
					onChange={(event) => {
						setFilter(event.currentTarget.value)
						setSelection('')
						setFilterCollapsed(new Set())
					}}
					onKeyDown={(event) => {
						if (event.key === 'Escape') {
							event.preventDefault()
							setFilter('')
						}
					}}
				/>
				{filtered && (
					<Text size="xs" c="dimmed" mt={4}>
						{filtered.matches} 项匹配
					</Text>
				)}
			</div>
			<Menu
				opened={menu !== null}
				onChange={(opened) => {
					if (!opened) setMenu(null)
				}}
				position="bottom-start"
				offset={0}
				shadow="md"
				withinPortal
			>
				<Menu.Target>
					<span
						style={{
							position: 'fixed',
							left: menu?.x ?? 0,
							top: menu?.y ?? 0,
							width: 1,
							height: 1,
							pointerEvents: 'none',
						}}
					/>
				</Menu.Target>
				<Menu.Dropdown>{menuItems(menu?.path ?? '')}</Menu.Dropdown>
			</Menu>
			<Modal
				opened={operation !== null}
				onClose={() => {
					if (!busy) setOperation(null)
				}}
				title={operation ? titles[operation.kind] : ''}
				centered
				closeOnClickOutside={!busy}
				closeOnEscape={!busy}
			>
				<form
					onSubmit={(event) => {
						event.preventDefault()
						void submit()
					}}
				>
					{error && (
						<Alert color="red" mb="md">
							{error}
						</Alert>
					)}
					{operation?.kind === 'delete' ? (
						<Text size="sm">
							删除“{operation.path}”
							{byPath.get(operation.path)?.kind === 'directory' ? '及其全部内容' : ''}
							？此操作无法撤销。
						</Text>
					) : (
						<TextInput
							label={operation?.kind === 'report' ? '报表文件夹路径' : '相对路径'}
							description={
								operation?.kind === 'report'
									? '自动创建同名 TypeScript 入口、表单默认值和 Typst 模板。'
									: undefined
							}
							value={name}
							onChange={(event) => setName(event.currentTarget.value)}
							data-autofocus
							disabled={busy}
						/>
					)}
					<Group justify="flex-end" mt="lg">
						<Button variant="default" disabled={busy} onClick={() => setOperation(null)}>
							取消
						</Button>
						<Button
							type="submit"
							color={operation?.kind === 'delete' ? 'red' : undefined}
							loading={busy}
							disabled={operation?.kind !== 'delete' && !name.trim()}
						>
							{operation?.kind === 'delete' ? '删除' : '确定'}
						</Button>
					</Group>
				</form>
			</Modal>
		</aside>
	)
}
