import { useEffect, useMemo, useRef, useState } from 'react'
import {
	ActionIcon,
	Alert,
	Button,
	Group,
	Menu,
	Modal,
	Popover,
	ScrollArea,
	Select,
	Stack,
	Text,
	TextInput,
	UnstyledButton,
} from '@mantine/core'
import {
	IconArrowDown,
	IconArrowUp,
	IconCopy,
	IconChevronDown,
	IconHistory,
	IconDots,
	IconPencil,
	IconPlus,
	IconSearch,
	IconTrash,
	IconSettings,
	IconSquare,
} from '@tabler/icons-react'
import {
	ActionBarPrimitive,
	AssistantRuntimeProvider,
	ComposerPrimitive,
	MessagePrimitive,
	ThreadPrimitive,
	useAuiState,
	useExternalStoreRuntime,
	defaultDirectiveFormatter,
	type TextMessagePartProps,
	type TriggerAdapter,
} from '@assistant-ui/react'
import '@assistant-ui/styles/index.css'
import './assistant.css'
import type { AiModel, AiSnapshot, AiThread, FileEntry } from '../shared/contracts'
import { api } from './api'
import { ProviderSettings } from './provider-settings'
import { toAssistantMessage } from './assistant-messages'
import { AssistantParts } from './assistant-parts'
import type { AssistantDraft, AssistantUiState } from './workspace'

function readableMessage(text: string) {
	return defaultDirectiveFormatter
		.parse(text)
		.map((segment) => (segment.kind === 'mention' ? `@${segment.label}` : segment.text))
		.join('')
}

function UserText({ text }: TextMessagePartProps) {
	return <span className="studio-user-text">{readableMessage(text)}</span>
}

function UserMessage() {
	return (
		<MessagePrimitive.Root className="aui-user-message-root">
			<div className="aui-user-message-content">
				<MessagePrimitive.Parts components={{ Text: UserText }} />
			</div>
		</MessagePrimitive.Root>
	)
}
function AssistantMessage() {
	const hasText = useAuiState((state) =>
		state.message.parts.some((part) => part.type === 'text' && part.text.trim()),
	)
	return (
		<MessagePrimitive.Root className="aui-assistant-message-root">
			<div className="aui-assistant-message-content">
				<AssistantParts />
			</div>
			{hasText && (
				<ActionBarPrimitive.Root className="aui-assistant-action-bar-root" hideWhenRunning>
					<ActionBarPrimitive.Copy className="aui-button-icon" aria-label="复制回复">
						<IconCopy size={16} />
					</ActionBarPrimitive.Copy>
				</ActionBarPrimitive.Root>
			)}
		</MessagePrimitive.Root>
	)
}

/** Pi owns messages and tools; assistant-ui owns the composer, transcript and scrolling. */
export function AssistantPanel(props: {
	projectId: string | null
	entries: FileEntry[]
	uiState: AssistantUiState
	onChanged(): void
}) {
	return props.projectId ? (
		<WorkspaceAssistant
			key={props.projectId}
			projectId={props.projectId}
			onChanged={props.onChanged}
			entries={props.entries}
			uiState={props.uiState}
		/>
	) : (
		<Text c="dimmed" p="md">
			打开项目后，可以让 AI 阅读文件、调整字段和排版。
		</Text>
	)
}

const keyOf = (value: { provider?: string; model?: string }) =>
	value.provider && value.model ? JSON.stringify([value.provider, value.model]) : null

function WorkspaceAssistant({
	projectId,
	onChanged,
	entries,
	uiState,
}: {
	projectId: string
	entries: FileEntry[]
	uiState: AssistantUiState
	onChanged(): void
}) {
	const path = `/api/projects/${encodeURIComponent(projectId)}/ai/threads`
	const [threads, setThreads] = useState<AiThread[]>([])
	const [active, setActive] = useState<string | null>(uiState.activeThreadId)
	const [models, setModels] = useState<AiModel[]>([])
	const [settingsOpened, setSettingsOpened] = useState(false)
	const [historyOpened, setHistoryOpened] = useState(false)
	const [search, setSearch] = useState('')
	const [error, setError] = useState<string>()
	const [busy, setBusy] = useState(false)
	const [dialog, setDialog] = useState<'rename' | 'delete' | null>(null)
	const [title, setTitle] = useState('')
	const [configuredModel, setConfiguredModel] = useState<string | null>(null)
	const listVersion = useRef(0)
	const runningIds = useRef(new Set<string>())
	const changed = useRef(onChanged)
	changed.current = onChanged
	const selected = threads.find((thread) => thread.id === active)
	const selectedTitle = selected ? readableMessage(selected.title) : 'AI 助手'
	const running = threads.find((thread) => thread.running)
	const visibleThreads = threads.filter((thread) =>
		readableMessage(thread.title).toLowerCase().includes(search.toLowerCase()),
	)
	const reportError = (cause: unknown) =>
		setError(cause instanceof Error ? cause.message : String(cause))
	async function refreshModels() {
		setModels(await api<AiModel[]>('/api/ai/models'))
	}
	useEffect(() => {
		uiState.activeThreadId = active
	}, [active, uiState])
	useEffect(() => {
		let disposed = false
		let timer: ReturnType<typeof setTimeout>
		async function loadModels() {
			try {
				const next = await api<AiModel[]>('/api/ai/models')
				if (!disposed) setModels(next)
			} catch (cause) {
				if (!disposed) reportError(cause)
			}
		}
		void loadModels()
		async function poll() {
			try {
				const version = listVersion.current
				const next = await api<AiThread[]>(path)
				if (disposed) return
				if (version !== listVersion.current) {
					timer = setTimeout(poll, 1000)
					return
				}
				if (
					Array.from(runningIds.current).some(
						(id) => !next.some((thread) => thread.id === id && thread.running),
					)
				)
					changed.current()
				runningIds.current = new Set(
					next.filter((thread) => thread.running).map((thread) => thread.id),
				)
				setThreads(next)
				setActive((id) =>
					id && next.some((thread) => thread.id === id) ? id : (next[0]?.id ?? null),
				)
			} catch (cause) {
				if (!disposed) reportError(cause)
			}
			if (!disposed) timer = setTimeout(poll, 1000)
		}
		void poll()
		return () => {
			disposed = true
			clearTimeout(timer)
		}
	}, [path])
	async function createThread() {
		listVersion.current++
		setBusy(true)
		setError(undefined)
		try {
			const next = await api<AiSnapshot>(path, { method: 'POST' })
			setThreads(await api<AiThread[]>(path))
			setActive(next.threadId)
			setConfiguredModel(null)
			setHistoryOpened(false)
		} catch (cause) {
			reportError(cause)
		} finally {
			listVersion.current++
			setBusy(false)
		}
	}
	async function submitDialog() {
		if (!selected) return
		listVersion.current++
		setBusy(true)
		setError(undefined)
		try {
			await api(
				`${path}/${encodeURIComponent(selected.id)}`,
				dialog === 'delete'
					? { method: 'DELETE' }
					: { method: 'PATCH', body: { title: title.trim() } },
			)
			const next = await api<AiThread[]>(path)
			setThreads(next)
			if (dialog === 'delete') {
				uiState.drafts.delete(selected.id)
				setActive(next[0]?.id ?? null)
			}
			setDialog(null)
		} catch (cause) {
			reportError(cause)
		} finally {
			listVersion.current++
			setBusy(false)
		}
	}
	return (
		<Stack gap={4} h="100%" p={6} style={{ minHeight: 0, minWidth: 0 }}>
			<ProviderSettings
				opened={settingsOpened}
				onClose={() => setSettingsOpened(false)}
				onChanged={(model) => {
					setConfiguredModel(JSON.stringify([model.provider, model.id]))
					void refreshModels().catch(reportError)
				}}
			/>
			<Group gap={4} wrap="nowrap" className="studio-thread-toolbar">
				<Popover
					opened={historyOpened}
					onChange={setHistoryOpened}
					width={340}
					position="bottom-start"
				>
					<Popover.Target>
						<Button
							variant="subtle"
							color="gray"
							size="xs"
							leftSection={<IconHistory size={14} />}
							rightSection={<IconChevronDown size={14} />}
							onClick={() => setHistoryOpened((value) => !value)}
							aria-label="切换 AI 会话"
							title={selectedTitle}
							className="studio-thread-selector"
						>
							{selectedTitle}
						</Button>
					</Popover.Target>
					<Popover.Dropdown p={8} style={{ maxWidth: 'calc(100vw - 24px)' }}>
						<TextInput
							aria-label="搜索会话"
							placeholder="搜索会话"
							value={search}
							onChange={(event) => setSearch(event.currentTarget.value)}
							leftSection={<IconSearch size={14} />}
							size="xs"
							mb={6}
						/>
						<ScrollArea.Autosize mah={280}>
							{visibleThreads.map((thread) => (
								<UnstyledButton
									key={thread.id}
									className="studio-thread-item"
									data-active={thread.id === active || undefined}
									onClick={() => {
										setActive(thread.id)
										setConfiguredModel(null)
										setHistoryOpened(false)
									}}
								>
									<Text size="sm" truncate>
										{readableMessage(thread.title)}
									</Text>
									<Text size="xs" c="dimmed">
										{thread.running
											? '正在生成…'
											: new Date(thread.updatedAt).toLocaleString('zh-CN', {
													month: 'numeric',
													day: 'numeric',
													hour: '2-digit',
													minute: '2-digit',
												})}
									</Text>
								</UnstyledButton>
							))}
							{visibleThreads.length === 0 && (
								<Text size="xs" c="dimmed" p="xs">
									没有匹配的会话
								</Text>
							)}
						</ScrollArea.Autosize>
					</Popover.Dropdown>
				</Popover>
				<Button
					variant="light"
					size="xs"
					leftSection={<IconPlus size={14} />}
					aria-label="新建 AI 会话"
					loading={busy}
					onClick={() => void createThread()}
				>
					新建
				</Button>
				<Menu position="bottom-end">
					<Menu.Target>
						<ActionIcon
							variant="subtle"
							color="gray"
							size={26}
							aria-label="会话操作"
							disabled={!selected || busy}
						>
							<IconDots size={16} />
						</ActionIcon>
					</Menu.Target>
					<Menu.Dropdown>
						<Menu.Item
							leftSection={<IconPencil size={15} />}
							onClick={() => {
								setTitle(selected ? selectedTitle : '')
								setDialog('rename')
							}}
						>
							重命名会话
						</Menu.Item>
						<Menu.Item
							color="red"
							leftSection={<IconTrash size={15} />}
							disabled={selected?.running}
							onClick={() => setDialog('delete')}
						>
							删除会话
						</Menu.Item>
					</Menu.Dropdown>
				</Menu>
			</Group>
			<Modal
				opened={dialog !== null}
				onClose={() => {
					if (!busy) setDialog(null)
				}}
				title={dialog === 'rename' ? '重命名会话' : '删除会话'}
				size="sm"
			>
				<form
					onSubmit={(event) => {
						event.preventDefault()
						void submitDialog()
					}}
				>
					{dialog === 'rename' ? (
						<TextInput
							autoFocus
							label="会话名称"
							value={title}
							maxLength={100}
							onChange={(event) => setTitle(event.currentTarget.value)}
						/>
					) : (
						<Text size="sm">
							删除“{selectedTitle}”及其聊天记录？项目文件不受影响，此操作无法撤销。
						</Text>
					)}
					<Group justify="flex-end" mt="md">
						<Button variant="default" disabled={busy} onClick={() => setDialog(null)}>
							取消
						</Button>
						<Button
							type="submit"
							loading={busy}
							color={dialog === 'delete' ? 'red' : undefined}
							disabled={dialog === 'rename' && !title.trim()}
						>
							{dialog === 'rename' ? '保存' : '删除'}
						</Button>
					</Group>
				</form>
			</Modal>
			{error && (
				<Alert color="red" title="AI 操作失败" withCloseButton onClose={() => setError(undefined)}>
					{error}
				</Alert>
			)}
			{active ? (
				<Conversation
					key={active}
					threadId={active}
					path={`${path}/${encodeURIComponent(active)}`}
					entries={entries}
					models={models}
					configuredModel={configuredModel}
					draft={uiState.drafts.get(active) ?? { text: '' }}
					saveDraft={(draft) => uiState.drafts.set(active, draft)}
					openSettings={() => setSettingsOpened(true)}
					onChanged={onChanged}
					blocked={Boolean(running && running.id !== active)}
					runningTitle={running && readableMessage(running.title)}
					showRunning={() => {
						if (running) {
							setActive(running.id)
							setConfiguredModel(null)
						}
					}}
				/>
			) : (
				<Stack align="center" justify="center" style={{ flex: 1 }}>
					<Text c="dimmed" size="sm">
						新建会话，开始完善项目
					</Text>
					<Button variant="light" size="xs" onClick={() => void createThread()} loading={busy}>
						新建会话
					</Button>
				</Stack>
			)}
		</Stack>
	)
}

function Conversation({
	threadId,
	path,
	entries,
	models,
	draft,
	saveDraft,
	openSettings,
	onChanged,
	blocked,
	runningTitle,
	showRunning,
	configuredModel,
}: {
	threadId: string
	path: string
	entries: FileEntry[]
	models: AiModel[]
	draft: AssistantDraft
	saveDraft(draft: AssistantDraft): void
	openSettings(): void
	onChanged(): void
	blocked: boolean
	runningTitle?: string
	showRunning(): void
	configuredModel: string | null
}) {
	const [snapshot, setSnapshot] = useState<AiSnapshot>({
		threadId,
		title: '',
		messages: [],
		running: false,
	})
	const [modelKey, setModelKey] = useState<string | null>(draft.modelKey ?? null)
	const [error, setError] = useState<string>()
	const [loading, setLoading] = useState(true)
	const [pending, setPending] = useState(false)
	const alive = useRef(false)
	const wasRunning = useRef(false)
	const changed = useRef(onChanged)
	changed.current = onChanged
	const selectedModel = useRef(draft.modelKey)
	const reportError = (cause: unknown) => {
		if (alive.current) setError(cause instanceof Error ? cause.message : String(cause))
	}
	const selectModel = (key: string | null) => {
		selectedModel.current = key
		setModelKey(key)
	}
	useEffect(() => {
		if (configuredModel) selectModel(configuredModel)
	}, [configuredModel])
	function accept(next: AiSnapshot) {
		if (!alive.current || next.threadId !== threadId) return
		setSnapshot(next)
		setLoading(false)
		if (selectedModel.current === undefined) {
			const key = keyOf(next)
			if (key) selectModel(key)
		}
		if (wasRunning.current && !next.running) changed.current()
		wasRunning.current = next.running
	}
	useEffect(() => {
		let disposed = false
		alive.current = true
		let timer: ReturnType<typeof setTimeout>
		async function poll() {
			try {
				const next = await api<AiSnapshot>(path)
				if (!disposed) accept(next)
			} catch (cause) {
				if (!disposed) reportError(cause)
			}
			if (!disposed) timer = setTimeout(poll, 500)
		}
		void poll()
		return () => {
			disposed = true
			alive.current = false
			clearTimeout(timer)
		}
	}, [path])
	useEffect(() => {
		if (!loading && !modelKey && selectedModel.current === undefined && models[0])
			selectModel(JSON.stringify([models[0].provider, models[0].id]))
	}, [loading, models, modelKey])
	const runtime = useExternalStoreRuntime({
		messages: snapshot.messages,
		convertMessage: toAssistantMessage,
		isRunning: snapshot.running,
		isDisabled: loading || pending || blocked,
		onNew: async (message) => {
			const text = message.content
				.flatMap((part) => (part.type === 'text' ? [part.text] : []))
				.join('\n')
			if (!modelKey || loading || pending || blocked) {
				runtime.thread.composer.setText(text)
				if (!modelKey) setError('请在输入框下方选择模型，或打开供应商设置填写凭据。')
				return
			}
			const [provider, model] = JSON.parse(modelKey) as [string, string]
			setError(undefined)
			setPending(true)
			try {
				const references = defaultDirectiveFormatter
					.parse(text)
					.flatMap((segment) =>
						segment.kind === 'mention' && ['folder', 'file'].includes(segment.type)
							? [segment.id]
							: [],
					)
				const next = await api<AiSnapshot>(path, {
					method: 'POST',
					body: { message: readableMessage(text), provider, model, references },
				})
				accept(next)
			} catch (cause) {
				reportError(cause)
				if (alive.current) runtime.thread.composer.setText(text)
				else draftState.current.saveDraft({ text, modelKey })
			} finally {
				if (alive.current) setPending(false)
			}
		},
		onCancel: async () => {
			try {
				accept(await api<AiSnapshot>(`${path}/abort`, { method: 'POST' }))
			} catch (cause) {
				reportError(cause)
			}
		},
	})
	const draftState = useRef({ draft, saveDraft })
	draftState.current.saveDraft = saveDraft
	useEffect(() => {
		runtime.thread.composer.setText(draftState.current.draft.text)
		return () =>
			draftState.current.saveDraft({
				text: runtime.thread.composer.getState().text,
				modelKey: selectedModel.current,
			})
	}, [runtime])
	const modelGroups = Array.from(new Set(models.map((model) => model.provider))).map(
		(provider) => ({
			group: provider,
			items: models
				.filter((model) => model.provider === provider)
				.map((model) => ({ value: JSON.stringify([model.provider, model.id]), label: model.name })),
		}),
	)
	if (
		modelKey &&
		!models.some((model) => JSON.stringify([model.provider, model.id]) === modelKey)
	) {
		const [provider, model] = JSON.parse(modelKey) as [string, string]
		modelGroups.push({
			group: provider,
			items: [{ value: modelKey, label: `${model}（请检查供应商配置）` }],
		})
	}
	return (
		<Stack gap={4} style={{ flex: 1, minHeight: 0, minWidth: 0 }}>
			{blocked && (
				<Group gap="xs">
					<Text size="xs" c="dimmed">
						“{runningTitle}”正在处理项目，请完成或停止后发送。
					</Text>
					<Button variant="subtle" size="compact-xs" onClick={showRunning}>
						查看运行会话
					</Button>
				</Group>
			)}
			{(error || snapshot.error) && (
				<Alert color="red" title="AI 操作失败">
					{error || snapshot.error}
				</Alert>
			)}
			{loading && (
				<Text size="xs" c="dimmed" role="status">
					正在加载会话…
				</Text>
			)}
			<AssistantRuntimeProvider runtime={runtime}>
				<ThreadPrimitive.Root
					className="aui-thread-root studio-assistant-thread"
					style={{
						flex: 1,
						minHeight: 0,
						minWidth: 0,
						display: 'flex',
						flexDirection: 'column',
						overflow: 'hidden',
					}}
				>
					<ThreadPrimitive.Viewport className="aui-thread-viewport" style={{ minHeight: 0 }}>
						<ThreadPrimitive.Empty>
							<div className="aui-thread-welcome-root">
								<Text size="xs" c="dimmed">
									描述需求，输入 @ 引用文件或文件夹。
								</Text>
							</div>
						</ThreadPrimitive.Empty>
						<ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
						<ThreadPrimitive.ViewportFooter className="aui-thread-viewport-footer">
							<ThreadPrimitive.ScrollToBottom
								className="aui-thread-scroll-to-bottom"
								aria-label="滚动到底部"
							>
								<IconArrowDown size={16} />
							</ThreadPrimitive.ScrollToBottom>
							<ComposerPrimitive.TriggerPopoverRoot>
								<WorkspaceMentions entries={entries} />
								<ComposerPrimitive.Root className="aui-composer-root aui-composer-attachment-dropzone">
									<ComposerPrimitive.Input
										className="aui-composer-input"
										minRows={1}
										maxRows={4}
										placeholder="描述想要的调整，@ 引用文件夹…"
										aria-label="发送给 AI 的消息"
									/>
									<div className="aui-composer-action-wrapper">
										<Group gap={2} wrap="nowrap" className="studio-composer-model">
											<Select
												aria-label="AI 模型"
												placeholder="选择模型"
												variant="unstyled"
												size="xs"
												searchable
												disabled={snapshot.running || loading || pending}
												value={modelKey}
												onChange={selectModel}
												data={modelGroups}
												nothingFoundMessage="没有匹配的模型"
												comboboxProps={{ position: 'top-start', withinPortal: true }}
											/>
											<ActionIcon
												variant="subtle"
												size="sm"
												aria-label="模型供应商设置"
												onClick={openSettings}
											>
												<IconSettings size={15} />
											</ActionIcon>
										</Group>
										{snapshot.running ? (
											<ComposerPrimitive.Cancel
												className="aui-composer-cancel"
												aria-label="停止生成"
											>
												<IconSquare size={16} />
											</ComposerPrimitive.Cancel>
										) : (
											<ComposerPrimitive.Send
												disabled={!modelKey || loading || pending || blocked}
												className="aui-composer-send"
												aria-label="发送消息"
											>
												<IconArrowUp size={16} />
											</ComposerPrimitive.Send>
										)}
									</div>
								</ComposerPrimitive.Root>
							</ComposerPrimitive.TriggerPopoverRoot>
						</ThreadPrimitive.ViewportFooter>
					</ThreadPrimitive.Viewport>
				</ThreadPrimitive.Root>
			</AssistantRuntimeProvider>
		</Stack>
	)
}

function WorkspaceMentions({ entries }: { entries: FileEntry[] }) {
	const adapter = useMemo<TriggerAdapter>(() => {
		const items = entries.map((entry) => ({
			id: entry.path,
			type: entry.kind === 'directory' ? 'folder' : 'file',
			label: entry.path,
			description: entry.kind === 'directory' ? '文件夹' : '文件',
		}))
		return {
			categories: () => [
				{ id: 'folder', label: '文件夹' },
				{ id: 'file', label: '文件' },
			],
			categoryItems: (category) => items.filter((item) => item.type === category),
			search: (query) =>
				items.filter((item) => item.label.toLowerCase().includes(query.toLowerCase())).slice(0, 40),
		}
	}, [entries])
	return (
		<ComposerPrimitive.TriggerPopover
			char="@"
			adapter={adapter}
			className="studio-mention-menu"
			aria-label="引用工作区文件"
		>
			<ComposerPrimitive.TriggerPopover.Directive />
			<ComposerPrimitive.TriggerPopoverBack>返回</ComposerPrimitive.TriggerPopoverBack>
			<ComposerPrimitive.TriggerPopoverCategories>
				{(categories) =>
					categories.map((category) => (
						<ComposerPrimitive.TriggerPopoverCategoryItem
							key={category.id}
							categoryId={category.id}
						>
							{category.label}
						</ComposerPrimitive.TriggerPopoverCategoryItem>
					))
				}
			</ComposerPrimitive.TriggerPopoverCategories>
			<ComposerPrimitive.TriggerPopoverItems>
				{(items) =>
					items.map((item, index) => (
						<ComposerPrimitive.TriggerPopoverItem key={item.id} item={item} index={index}>
							{item.type === 'folder' ? '📁 ' : ''}
							{item.label}
						</ComposerPrimitive.TriggerPopoverItem>
					))
				}
			</ComposerPrimitive.TriggerPopoverItems>
		</ComposerPrimitive.TriggerPopover>
	)
}
