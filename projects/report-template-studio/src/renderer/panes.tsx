import { useEffect, useMemo, useRef, useState } from 'react'
import {
	ActionIcon,
	Alert,
	Button,
	Group,
	Menu,
	SegmentedControl,
	Text,
	Tooltip,
} from '@mantine/core'
import { IconDots, IconDownload, IconRefresh, IconDeviceFloppy } from '@tabler/icons-react'
import { useWorkbenchContentLifecycle } from '@worksplit/react'
import { CodeEditor } from './code-editor'
import { DataForm } from './data-form'
import { Preview } from './preview'
import { api } from './api'
import { useWorkspace } from './workspace-context'

function SaveStatus({
	saving,
	dirty,
	error,
}: {
	saving?: boolean
	dirty?: boolean
	error?: string
}) {
	return (
		<Text size="xs" c={error ? 'red' : dirty ? 'orange' : 'dimmed'} role="status">
			{error ? '保存失败' : saving ? '保存中…' : dirty ? '待保存' : '已保存'}
		</Text>
	)
}

function FileActions({ path }: { path: string }) {
	const workspace = useWorkspace()
	const file = workspace.files.get(path)
	return (
		<Menu position="bottom-end" withinPortal>
			<Menu.Target>
				<ActionIcon variant="subtle" color="gray" aria-label="文件操作">
					<IconDots size={17} />
				</ActionIcon>
			</Menu.Target>
			<Menu.Dropdown>
				<Menu.Item
					leftSection={<IconDeviceFloppy size={16} />}
					rightSection={
						<Text size="xs" c="dimmed">
							Ctrl / ⌘ S
						</Text>
					}
					disabled={!file?.dirty || file.saving}
					onClick={() => void workspace.save(path)}
				>
					保存
				</Menu.Item>
				<Menu.Item
					leftSection={<IconRefresh size={16} />}
					onClick={() => {
						if (!file?.dirty || window.confirm('重新载入将放弃当前草稿，是否继续？'))
							void workspace.reload(path).catch((cause) => {
								workspace.error = String(cause)
								workspace.emit()
							})
					}}
				>
					从磁盘重新载入
				</Menu.Item>
			</Menu.Dropdown>
		</Menu>
	)
}

/** Content only: the containing tab owns close/save lifecycle. */
function FileEditorContent({ path, scope = 'file' }: { path: string; scope?: string }) {
	const workspace = useWorkspace()
	const file = workspace.files.get(path)
	const diagnostics = [...workspace.documents.values()].flatMap((document) => document.diagnostics)
	return (
		<>
			{file?.error && <Alert color="red">{file.error}</Alert>}
			{file ? (
				<div className="workspace-code">
					<CodeEditor
						workspaceId={`${workspace.project.id}:${scope}:${path}`}
						file={path}
						files={{ ...workspace.textFiles(), [path]: file.content }}
						onChange={(changed, source) => workspace.edit(changed, source)}
						onClickPosition={(line, column) => workspace.revealPreview({ path, line, column })}
						diagnostics={file.dirty ? [] : diagnostics}
						readOnly={file.missing}
						location={workspace.location?.path === path ? workspace.location : undefined}
					/>
				</div>
			) : (
				<Text p="md">文件已删除、为二进制资产，或尚未读取。</Text>
			)}
		</>
	)
}

export function FilePane({ path }: { path: string }) {
	const workspace = useWorkspace()
	const file = workspace.files.get(path)
	const discard = useRef(false)
	useWorkbenchContentLifecycle(
		useMemo(
			() => ({
				isDirty: () => Boolean(workspace.files.get(path)?.dirty),
				getCloseRevision: () => workspace.files.get(path)?.token ?? 0,
				beforeLeave: async () => {
					await workspace.save(path)
					discard.current =
						Boolean(workspace.files.get(path)?.dirty) &&
						window.confirm(`关闭 ${path} 会放弃尚未保存的草稿，是否继续？`)
					return !workspace.files.get(path)?.dirty || discard.current
				},
				dispose: () => (discard.current ? workspace.discard(path) : undefined),
				save: () => workspace.save(path),
			}),
			[workspace, path],
		),
	)
	return (
		<section
			className="workspace-pane"
			onKeyDownCapture={(event) => {
				if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
					event.preventDefault()
					event.stopPropagation()
					void workspace.save(path)
				}
			}}
		>
			<Group className="pane-toolbar" justify="space-between" wrap="nowrap">
				<Text size="sm" truncate title={path}>
					{path}
				</Text>
				<Group gap="xs" wrap="nowrap">
					<SaveStatus {...file} />
					<FileActions path={path} />
				</Group>
			</Group>
			<FileEditorContent path={path} />
		</section>
	)
}

export function FormPane({ entry }: { entry: string }) {
	const workspace = useWorkspace()
	const [mode, setMode] = useState('form')
	const [codeOpened, setCodeOpened] = useState(false)
	const discard = useRef(false)
	useEffect(() => {
		workspace.ensureDocument(entry)
	}, [workspace, entry])
	const document = workspace.documents.get(entry)
	const file = workspace.files.get(entry)
	useWorkbenchContentLifecycle(
		useMemo(
			() => ({
				isDirty: () =>
					Boolean(workspace.documents.get(entry)?.inputDirty || workspace.files.get(entry)?.dirty),
				getCloseRevision: () =>
					`${workspace.documents.get(entry)?.inputToken ?? 0}:${workspace.files.get(entry)?.token ?? 0}`,
				beforeLeave: async () => {
					await Promise.all([workspace.saveInput(entry), workspace.save(entry)])
					if (workspace.documents.get(entry)?.inputDirty) return false
					discard.current =
						Boolean(workspace.files.get(entry)?.dirty) &&
						window.confirm(`关闭 ${entry} 会放弃尚未保存的代码草稿，是否继续？`)
					return !workspace.files.get(entry)?.dirty || discard.current
				},
				dispose: () => (discard.current ? workspace.discard(entry) : undefined),
				save: async () => {
					await Promise.all([workspace.saveInput(entry), workspace.save(entry)])
				},
			}),
			[workspace, entry],
		),
	)
	return (
		<section
			className="workspace-pane"
			onFocusCapture={() => workspace.preferPreview(entry)}
			onKeyDownCapture={(event) => {
				if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
					event.preventDefault()
					event.stopPropagation()
					void workspace.save(entry)
					void workspace.saveInput(entry)
				}
			}}
		>
			<Group className="pane-toolbar" justify="space-between" wrap="nowrap">
				<SegmentedControl
					size="xs"
					aria-label="报表编辑模式"
					value={mode}
					onChange={(value) => {
						setMode(value)
						if (value === 'code') setCodeOpened(true)
					}}
					data={[
						{ value: 'form', label: '表单' },
						{ value: 'code', label: '入口代码' },
					]}
				/>
				<Group gap="xs" wrap="nowrap">
					<SaveStatus
						saving={mode === 'code' ? file?.saving : document?.inputSaving}
						dirty={mode === 'code' ? file?.dirty : document?.inputDirty}
						error={mode === 'code' ? file?.error : document?.inputError}
					/>
					{mode === 'code' ? (
						<FileActions path={entry} />
					) : (
						document?.inputError && (
							<Tooltip label="重试保存">
								<ActionIcon
									variant="subtle"
									aria-label="重试保存"
									onClick={() => void workspace.saveInput(entry)}
								>
									<IconRefresh size={17} />
								</ActionIcon>
							</Tooltip>
						)
					)}
				</Group>
			</Group>
			{mode === 'form' && (document?.error || document?.inputError) && (
				<Alert color="red" title={document?.inputError ? '填写数据尚未保存' : '报表需要修复'}>
					{document?.inputError ?? document?.error}
				</Alert>
			)}
			<div className="form-scroll" style={{ display: mode === 'form' ? undefined : 'none' }}>
				{document?.fields.length ? (
					<DataForm
						key={JSON.stringify(document.fields)}
						fields={document.fields}
						data={document.data}
						onChange={(next) => {
							void workspace.writeData(entry, next).catch((cause) => {
								workspace.error = String(cause)
								workspace.emit()
							})
						}}
					/>
				) : (
					<Text c="dimmed">
						{document?.busy ? '正在读取表单…' : '尚无可用表单，请切换到入口代码查看或修改 schema。'}
					</Text>
				)}
			</div>
			{codeOpened && (
				<div
					className="workspace-pane"
					style={{ display: mode === 'code' ? undefined : 'none', flex: 1, minHeight: 0 }}
				>
					<FileEditorContent path={entry} scope="report" />
				</div>
			)}
		</section>
	)
}

export function PreviewPane({ entry }: { entry: string }) {
	const workspace = useWorkspace()
	useEffect(() => {
		workspace.ensureDocument(entry)
	}, [workspace, entry])
	const document = workspace.documents.get(entry)
	const name =
		document?.result?.name ??
		workspace.tree?.documents.find((item) => item.entry === entry)?.name ??
		entry.split('/').at(-1)?.replace(/\.ts$/, '') ??
		entry
	const dirty = [...workspace.files.values()].some((file) => file.dirty)
	const exportPdf = async () => {
		if (!document?.result) return
		const artifact = await api.exportPdf({
			projectId: workspace.project.id,
			entry,
			revision: document.result.revision,
		})
		await window.studio.saveArtifact({
			suggestedName: `${
				entry
					.split('/')
					.at(-1)
					?.replace(/\.[^.]+$/, '') ?? 'document'
			}.pdf`,
			artifactId: artifact.id,
		})
	}
	return (
		<section className="workspace-pane preview-pane">
			<Group className="pane-toolbar" justify="space-between" wrap="nowrap">
				<Text size="sm" fw={600} truncate title={entry}>
					{name}
				</Text>
				<Group gap="xs" wrap="nowrap">
					<Tooltip label={document?.busy ? '正在更新预览' : '刷新预览'}>
						<ActionIcon
							variant="subtle"
							color="gray"
							aria-label="刷新预览"
							loading={document?.busy}
							onClick={() => void workspace.compile(entry)}
						>
							<IconRefresh size={17} />
						</ActionIcon>
					</Tooltip>
					<Button
						size="xs"
						variant="light"
						leftSection={<IconDownload size={15} />}
						disabled={
							!document?.result ||
							document.busy ||
							document.inputDirty ||
							document.inputSaving ||
							Boolean(document.error) ||
							dirty
						}
						onClick={() =>
							void exportPdf().catch((cause) => {
								workspace.error = String(cause)
								workspace.emit()
							})
						}
					>
						导出 PDF
					</Button>
				</Group>
			</Group>
			{document?.error && (
				<Alert
					color="red"
					title={document.result ? '更新失败 · 显示上次成功预览' : '无法生成预览'}
					className="compile-error"
				>
					{document.error}
				</Alert>
			)}
			<Preview workspace={workspace} entry={entry} result={document?.preview ?? null} />
		</section>
	)
}
