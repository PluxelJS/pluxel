import { useEffect, useMemo, useState } from 'react'
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
import { editorLifecycle } from './editor-lifecycle'
import { BodyEditor } from './body-editor'

const saveShortcut =
	typeof navigator !== 'undefined' && /Mac|iP(hone|ad|od)/.test(navigator.platform)
		? '⌘S'
		: 'Ctrl+S'

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
					title={`保存（${saveShortcut}）`}
					rightSection={
						<Text size="xs" c="dimmed">
							{saveShortcut}
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
						if (
							!file?.dirty ||
							window.confirm('重新载入将放弃此文件在所有视图中的共享草稿，是否继续？')
						)
							void workspace.reload(path).catch((cause) => {
								workspace.error = String(cause)
								workspace.emit()
							})
					}}
				>
					从磁盘重新载入
				</Menu.Item>
				<Menu.Item
					disabled={!file?.dirty}
					onClick={() => {
						if (window.confirm('放弃此文件在所有视图中的共享草稿？'))
							void workspace.discard(path).catch((cause) => {
								workspace.error = String(cause)
								workspace.emit()
							})
					}}
				>
					放弃草稿
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
	useWorkbenchContentLifecycle(
		useMemo(() => editorLifecycle(workspace, path, 'file'), [workspace, path]),
	)
	return (
		<section
			className="workspace-pane"
			onKeyDownCapture={(event) => {
				if (
					!event.defaultPrevented &&
					!event.nativeEvent.isComposing &&
					(event.ctrlKey || event.metaKey) &&
					!event.shiftKey &&
					!event.altKey &&
					event.key.toLowerCase() === 's'
				) {
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
	const [bodyOpened, setBodyOpened] = useState(false)
	useEffect(() => workspace.retainDocument(entry), [workspace, entry])
	const document = workspace.documents.get(entry)
	const file = workspace.files.get(entry)
	useEffect(() => {
		if (workspace.regionLocation?.entry === entry) {
			setBodyOpened(true)
			setMode('body')
		}
	}, [entry, workspace.regionLocation])
	useWorkbenchContentLifecycle(
		useMemo(() => editorLifecycle(workspace, entry, 'form'), [workspace, entry]),
	)
	return (
		<section
			className="workspace-pane"
			onFocusCapture={() => workspace.preferPreview(entry)}
			onKeyDownCapture={(event) => {
				if (
					!event.defaultPrevented &&
					!event.nativeEvent.isComposing &&
					(event.ctrlKey || event.metaKey) &&
					!event.shiftKey &&
					!event.altKey &&
					event.key.toLowerCase() === 's'
				) {
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
						if (value === 'body') setBodyOpened(true)
					}}
					data={[
						{ value: 'form', label: '表单' },
						...(document?.inputLoaded && document.description?.editor
							? [{ value: 'body', label: '正文' }]
							: []),
						{ value: 'code', label: '入口代码' },
					]}
				/>
				<Group gap="xs" wrap="nowrap">
					<SaveStatus
						saving={mode === 'code' ? file?.saving : document?.inputSaving}
						dirty={mode === 'code' ? file?.dirty : document?.inputDirty}
						error={
							mode === 'code'
								? file?.error
								: document?.inputConflict
									? '保存冲突'
									: document?.inputError
						}
					/>
					{mode === 'code' ? (
						<FileActions path={entry} />
					) : (
						document?.inputError &&
						!document.inputConflict && (
							<Tooltip label={`重试保存（${saveShortcut}）`}>
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
			{mode !== 'code' && document?.inputConflict && (
				<Alert color="orange" title="填写数据与正文存在保存冲突" style={{ maxHeight: '50%' }}>
					<Text size="sm">本地草稿已保留。检查两个版本后，选择要保留的内容。</Text>
					<details>
						<summary>本地草稿</summary>
						<pre>{JSON.stringify({ data: document.data, editor: document.editor }, null, 2)}</pre>
					</details>
					<details>
						<summary>冲突时读取的已保存版本</summary>
						<pre>
							{JSON.stringify(
								{ data: document.inputConflict.data, editor: document.inputConflict.editor },
								null,
								2,
							)}
						</pre>
					</details>
					<Group mt="sm">
						<Button
							size="xs"
							loading={document.inputSaving}
							onClick={() => void workspace.resolveInputConflict(entry, 'local')}
						>
							保留本地并覆盖已保存版本
						</Button>
						<Button
							size="xs"
							variant="default"
							disabled={document.inputSaving}
							onClick={() => void workspace.resolveInputConflict(entry, 'saved')}
						>
							载入已保存版本，放弃本地修改
						</Button>
					</Group>
				</Alert>
			)}
			{mode !== 'code' && !document?.inputConflict && (document?.error || document?.inputError) && (
				<Alert color="red" title={document?.inputError ? '填写数据尚未保存' : '报表需要修复'}>
					{document?.inputError ?? document?.error}
				</Alert>
			)}
			<div
				inert={document?.bodyLocked}
				className="form-scroll"
				style={{ display: mode === 'form' ? undefined : 'none' }}
			>
				{document?.inputLoaded && document.fields.length > 0 ? (
					<DataForm
						key={JSON.stringify(document.fields)}
						fields={document.fields}
						data={document.data}
						parsedData={document.result?.data}
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
			{bodyOpened && document?.description?.editor && (
				<div
					inert={document.bodyLocked}
					style={{
						display: mode === 'body' ? undefined : 'none',
						flex: 1,
						minHeight: 0,
						overflow: 'hidden',
					}}
				>
					<BodyEditor
						key={`${entry}:${document.inputEpoch ?? 0}`}
						entry={entry}
						description={document.description.editor}
					/>
				</div>
			)}
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
	useEffect(() => workspace.retainDocument(entry), [workspace, entry])
	const document = workspace.documents.get(entry)
	const name =
		document?.result?.name ??
		workspace.tree?.documents.find((item) => item.entry === entry)?.name ??
		entry.split('/').at(-1)?.replace(/\.ts$/, '') ??
		entry
	const dirty = Object.keys(document?.preview?.sourceVersions ?? {}).some(
		(path) => workspace.files.get(path)?.dirty,
	)
	const exportPdf = async () => {
		if (!document?.result || dirty) return
		if (document.result.clientRevision !== (document.inputToken ?? 0))
			await workspace.compile(entry)
		const current = workspace.documents.get(entry)
		if (
			!current?.result ||
			current.error ||
			current.result.clientRevision !== (current.inputToken ?? 0)
		)
			return
		const artifact = await api.exportPdf({
			projectId: workspace.project.id,
			entry,
			revision: current.result.revision,
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
						disabled={!document?.result || document.busy || Boolean(document.error) || dirty}
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
			{dirty && (
				<Alert color="orange">
					模板源码尚未保存，预览显示已保存的模板。保存源码后可导航或导出当前草稿。
				</Alert>
			)}
			{document?.result && document.result.clientRevision !== (document.inputToken ?? 0) && (
				<Text size="xs" c="dimmed" px="md">
					正文或数据已改变，正在准备当前草稿的预览。
				</Text>
			)}
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
