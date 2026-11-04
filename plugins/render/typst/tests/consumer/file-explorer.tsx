import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react'
import type { TypstSourceProject } from '@pluxel/plugin-typst/source/browser'
import { exampleTitles, type ExampleId } from './examples'

export type WorkspaceFolder = {
	project: TypstSourceProject
	initialFiles: Record<string, string>
}
export type WorkspaceFolders = Record<ExampleId, WorkspaceFolder>
type Row = {
	id: string
	folder: ExampleId
	path: string
	name: string
	depth: number
	directory: boolean
	parent?: string
}

/** A file tree over the actual project snapshots, without a second file model. */
export function FileExplorer({
	folders,
	activeFolder,
	activePath,
	onOpen,
	onCreate,
}: {
	folders: WorkspaceFolders
	activeFolder: ExampleId
	activePath: string
	onOpen(folder: ExampleId, path: string): void
	onCreate(path: string): Promise<string | undefined>
}) {
	useSyncExternalStore(
		(listener) => {
			const unsubscribe = Object.values(folders).map(({ project }) => project.subscribe(listener))
			return () => unsubscribe.forEach((stop) => stop())
		},
		() =>
			Object.values(folders)
				.map(({ project }) => project.revision)
				.join(':'),
	)
	const [collapsed, setCollapsed] = useState(
		() => new Set(['report:lib/', 'application-form:lib/']),
	)
	const [focused, setFocused] = useState(`${activeFolder}:${activePath}`)
	const [creating, setCreating] = useState(false)
	const [creatingFile, setCreatingFile] = useState(false)
	const [newPath, setNewPath] = useState('')
	const [issue, setIssue] = useState('')
	const input = useRef<HTMLInputElement>(null)
	const tree = useRef<HTMLDivElement>(null)
	useEffect(() => {
		setCollapsed((current) => {
			const next = new Set(current)
			next.delete(`${activeFolder}:`)
			const parts = activePath.split('/')
			for (let index = 1; index < parts.length; index++)
				next.delete(`${activeFolder}:${parts.slice(0, index).join('/')}/`)
			return next
		})
	}, [activeFolder, activePath])
	useEffect(() => {
		if (creating) input.current?.focus()
	}, [creating])
	const rows: Row[] = []
	for (const folder of Object.keys(folders) as ExampleId[]) {
		const root = `${folder}:`
		rows.push({ id: root, folder, path: '', name: folder, depth: 0, directory: true })
		if (collapsed.has(root)) continue
		const paths = Object.keys(folders[folder].project.snapshot().files)
		const visit = (prefix: string, depth: number, parent: string) => {
			const children = new Map<string, boolean>()
			for (const path of paths) {
				if (!path.startsWith(prefix)) continue
				const rest = path.slice(prefix.length)
				const slash = rest.indexOf('/')
				children.set(slash < 0 ? rest : rest.slice(0, slash + 1), slash >= 0)
			}
			for (const [name, directory] of [...children].sort(([a, ad], [b, bd]) =>
				ad === bd ? a.localeCompare(b) : ad ? -1 : 1,
			)) {
				const path = prefix + name
				const id = `${folder}:${path}`
				rows.push({ id, folder, path, name: name.replace(/\/$/, ''), depth, directory, parent })
				if (directory && !collapsed.has(id)) visit(path, depth + 1, id)
			}
		}
		visit('', 1, root)
	}
	const tabStop = rows.some((row) => row.id === focused)
		? focused
		: (rows.find((row) => row.id === `${activeFolder}:${activePath}`)?.id ?? rows[0]?.id)
	const toggle = (id: string) =>
		setCollapsed((current) => {
			const next = new Set(current)
			if (next.has(id)) next.delete(id)
			else next.add(id)
			return next
		})
	return (
		<aside className="file-explorer" aria-label="文件资源管理器">
			<div className="explorer-heading">
				<h2>文件</h2>
				<button
					type="button"
					aria-label="新建文件"
					disabled={creatingFile}
					title="在当前文件夹新建 .typ 文件"
					onClick={() => {
						setNewPath(
							activePath.includes('/') ? activePath.slice(0, activePath.lastIndexOf('/') + 1) : '',
						)
						setIssue('')
						setCreating(true)
					}}
				>
					新建文件
				</button>
			</div>
			{creating && (
				<form
					className="file-create"
					aria-label="新建文件"
					onSubmit={async (event) => {
						event.preventDefault()
						if (creatingFile) return
						if (!newPath.endsWith('.typ')) {
							setIssue('文件名需要以 .typ 结尾。')
							return
						}
						setCreatingFile(true)
						try {
							const error = await onCreate(newPath)
							if (error) setIssue(error)
							else setCreating(false)
						} catch (error) {
							setIssue(String(error))
						} finally {
							setCreatingFile(false)
						}
					}}
				>
					<label htmlFor="new-file-path">{activeFolder} /</label>
					<input
						ref={input}
						id="new-file-path"
						aria-label="新文件路径"
						placeholder="sections/chapter.typ"
						value={newPath}
						readOnly={creatingFile}
						onChange={(event) => setNewPath(event.currentTarget.value)}
						onKeyDown={(event) => {
							if (event.key === 'Escape' && !creatingFile) {
								event.preventDefault()
								setCreating(false)
							}
						}}
						required
					/>
					<div>
						<button type="submit" disabled={creatingFile}>
							创建
						</button>
						<button type="button" disabled={creatingFile} onClick={() => setCreating(false)}>
							取消
						</button>
					</div>
					{issue && <p role="alert">{issue}</p>}
				</form>
			)}
			<div
				ref={tree}
				role="tree"
				tabIndex={-1}
				aria-label="项目文件"
				onKeyDown={(event) => {
					const button = (event.target as HTMLElement).closest<HTMLButtonElement>(
						'button[role="treeitem"]',
					)
					if (!button) return
					const index = rows.findIndex((row) => row.id === button.dataset.node)
					const row = rows[index]
					if (!row) return
					let target: Row | undefined
					if (event.key === 'ArrowDown') target = rows[index + 1]
					else if (event.key === 'ArrowUp') target = rows[index - 1]
					else if (event.key === 'Home') target = rows[0]
					else if (event.key === 'End') target = rows.at(-1)
					else if (event.key === 'ArrowRight' && row.directory) {
						if (collapsed.has(row.id)) toggle(row.id)
						else target = rows[index + 1]
					} else if (event.key === 'ArrowLeft') {
						if (row.directory && !collapsed.has(row.id)) toggle(row.id)
						else target = rows.find((item) => item.id === row.parent)
					} else return
					event.preventDefault()
					if (target) {
						const buttons = tree.current?.querySelectorAll<HTMLButtonElement>('[role="treeitem"]')
						buttons?.[rows.indexOf(target)]?.focus()
					}
				}}
			>
				{rows.map((row) => (
					<button
						type="button"
						role="treeitem"
						key={row.id}
						data-node={row.id}
						data-folder={row.folder}
						data-path={row.path}
						aria-level={row.depth + 1}
						aria-expanded={row.directory ? !collapsed.has(row.id) : undefined}
						aria-selected={!row.directory && row.folder === activeFolder && row.path === activePath}
						tabIndex={row.id === tabStop ? 0 : -1}
						className={`file-row${row.directory ? ' file-folder' : ''}`}
						style={{ '--depth': row.depth } as CSSProperties}
						title={
							row.directory
								? row.depth === 0
									? exampleTitles[row.folder]
									: row.path
								: `${row.folder}/${row.path}${folders[row.folder].project.isWritable(row.path) ? '' : ' · 只读'}`
						}
						onFocus={() => setFocused(row.id)}
						onClick={() => (row.directory ? toggle(row.id) : onOpen(row.folder, row.path))}
					>
						<span className="file-label">{row.name}</span>
						<span className="file-kind">
							{row.depth === 0
								? exampleTitles[row.folder]
								: !row.directory && !folders[row.folder].project.isWritable(row.path)
									? '只读'
									: ''}
						</span>
					</button>
				))}
			</div>
		</aside>
	)
}
