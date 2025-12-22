import {
	ActionIcon,
	Alert,
	Badge,
	Button,
	Group,
	Loader,
	Paper,
	Select,
	Stack,
	Text,
	Textarea,
	TextInput,
	useMantineColorScheme,
	useMantineTheme,
} from '@mantine/core'
import {
	type GlobalExtensionContext,
	type PluginExtensionContext,
	rpcErrorMessage,
} from '@pluxel/hmr/web/react'
import {
	IconCircleCheck,
	IconCircleDashed,
	IconDashboard,
	IconListCheck,
	IconMessage2,
	IconPlayerPlay,
	IconRocket,
	IconTrash,
} from '@tabler/icons-react'
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from 'react'

type PluginWithUIRpc = PluginExtensionContext['services']['hmr']['rpc']['PluginWithUI']
type PluginOverview = Awaited<ReturnType<PluginWithUIRpc['overview']>>
type PluginNote = Awaited<ReturnType<PluginWithUIRpc['notes']>>[number]
type PluginTask = Awaited<ReturnType<PluginWithUIRpc['tasks']>>[number]
type PluginActivity = Awaited<ReturnType<PluginWithUIRpc['activity']>>[number]
type PluginSse = ReturnType<PluginExtensionContext['services']['hmr']['createSse']>

const PluginApiContext = createContext<{ rpc: PluginWithUIRpc; sse: PluginSse } | null>(null)

export function PluginApiProvider({
	ctx,
	children,
}: {
	ctx: PluginExtensionContext
	children: ReactNode
}) {
	const hmr = ctx.services.hmr
	const rpc = hmr.rpc.PluginWithUI
	const sseClient = useMemo(() => hmr.sse, [hmr])
	const value = useMemo(() => ({ rpc, sse: sseClient }), [rpc, sseClient])
	return <PluginApiContext.Provider value={value}>{children}</PluginApiContext.Provider>
}

export function usePluginApi() {
	const ctx = useContext(PluginApiContext)
	if (!ctx) throw new Error('usePluginApi must be used within PluginApiProvider')
	return ctx
}

export const taskPriorityLabel: Record<PluginTask['priority'], string> = {
	low: '低',
	medium: '中',
	high: '高',
}

export const taskPriorityColor: Record<PluginTask['priority'], string> = {
	low: 'gray',
	medium: 'blue',
	high: 'red',
}

export const taskStatusLabel: Record<PluginTask['status'], string> = {
	todo: '待办',
	doing: '进行中',
	done: '完成',
}

export const nextStatus = (status: PluginTask['status']): PluginTask['status'] => {
	if (status === 'todo') return 'doing'
	if (status === 'doing') return 'done'
	return 'todo'
}

export const formatDuration = (ms: number): string => {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000))
	const minutes = Math.floor(totalSeconds / 60)
	const seconds = totalSeconds % 60
	if (minutes === 0) {
		return `${seconds}s`
	}
	if (minutes < 60) {
		return `${minutes}m ${seconds}s`
	}
	const hours = Math.floor(minutes / 60)
	const remainingMinutes = minutes % 60
	return `${hours}h ${remainingMinutes}m`
}

export const formatTimestamp = (value: number): string => {
	return new Date(value).toLocaleTimeString()
}

// Header 按钮组件
export function HeaderButton({ ctx: _ctx }: { ctx: GlobalExtensionContext }) {
	return (
		<Button variant="light" size="xs" leftSection={<IconRocket size={14} />} color="grape">
			PluginWithUI
		</Button>
	)
}

export function GlobalStatusBar({ ctx }: { ctx: GlobalExtensionContext }) {
	const hmr = ctx.services.hmr
	const ready = ctx.runningPluginsReady
	const count = ctx.runningPlugins.size
	const [extVersion, setExtVersion] = useState<number>(0)

	useEffect(() => {
		const stream = hmr.sse
		const off = stream.extensions.on((msg) => {
			const payload = msg.payload
			if (payload?.type === 'sync') setExtVersion(payload.version)
			if (payload?.type === 'update' || payload?.type === 'remove') setExtVersion(payload.version)
		})
		return () => {
			off()
		}
	}, [hmr])

	return (
		<Group gap="xs">
			<Badge variant="light" color={ready ? 'teal' : 'gray'}>
				{ready ? 'Plugins Ready' : 'Plugins Loading'}
			</Badge>
			<Text size="xs" c="dimmed">
				Running: {count}
			</Text>
			<Text size="xs" c="dimmed">
				Ext v{extVersion}
			</Text>
		</Group>
	)
}

// 实时时间（来自插件 SSE tick）
export function RealTimeTicker({ sse }: { sse: PluginSse }) {
	const [now, setNow] = useState<string>(() => new Date().toLocaleTimeString())
	const [connected, setConnected] = useState(false)

	useEffect(() => {
		const offOpen = sse.onOpen(() => setConnected(true))
		const offError = sse.onError(() => setConnected(false))
		const offTick = sse.PluginWithUI.on(
			(msg) => {
				const payload = msg.payload
				if (payload?.type === 'tick' && typeof payload.now === 'number') {
					setNow(new Date(payload.now).toLocaleTimeString())
				}
			},
			['tick', 'ready'],
		)
		return () => {
			offOpen()
			offError()
			offTick()
		}
	}, [sse])

	return (
		<Paper withBorder p="sm" radius="md">
			<Group justify="space-between" align="center">
				<Group gap="xs">
					<Badge color={connected ? 'teal' : 'red'} variant="light">
						{connected ? 'SSE 已连接' : 'SSE 未连接'}
					</Badge>
					<Text size="sm" fw={600}>
						插件实时时间
					</Text>
				</Group>
				<Text size="lg" fw={700}>
					{now}
				</Text>
			</Group>
		</Paper>
	)
}

// 任务列表（演示第二个 Collection）
export function TaskBoard({ sse }: { sse: PluginSse }) {
	const [tasks, setTasks] = useState<PluginTask[]>([])
	const [title, setTitle] = useState('')
	const [priority, setPriority] = useState<PluginTask['priority']>('medium')
	const [loading, setLoading] = useState(true)
	const [submitting, setSubmitting] = useState(false)
	const [updatingId, setUpdatingId] = useState<string | null>(null)
	const [error, setError] = useState<string | null>(null)
	const mountedRef = useRef(true)

	const { rpc } = usePluginApi()

	useEffect(() => {
		return () => {
			mountedRef.current = false
		}
	}, [])

	const fetchTasks = useCallback(async () => {
		return rpc.tasks()
	}, [rpc])

	const refreshTasks = useCallback(
		async (options?: { silent?: boolean }) => {
			if (!options?.silent) {
				setLoading(true)
			}
			try {
				const list = await fetchTasks()
				if (!mountedRef.current) return
				setTasks(list)
				setError(null)
			} catch (error) {
				if (!mountedRef.current) return
				setError(rpcErrorMessage(error, '无法加载插件任务'))
			} finally {
				if (!options?.silent && mountedRef.current) {
					setLoading(false)
				}
			}
		},
		[fetchTasks],
	)

	useEffect(() => {
		refreshTasks().catch(() => undefined)
	}, [refreshTasks])

	useEffect(() => {
		const off = sse.PluginWithUI.on(
			(msg) => {
				const payload = msg.payload
				if (!payload || typeof payload !== 'object') return
				const record = payload as { type?: unknown; tasks?: unknown }
				if (record.type === 'cursor' && Array.isArray(record.tasks)) {
					setTasks(record.tasks as PluginTask[])
					setLoading(false)
					return
				}
				if (record.type === 'sync' && Array.isArray(record.tasks)) {
					setTasks(record.tasks as PluginTask[])
					setLoading(false)
				}
			},
			['cursor', 'sync'],
		)
		return () => off()
	}, [sse])

	const handleAdd = async () => {
		const trimmed = title.trim()
		if (!trimmed) {
			setError('请输入任务标题')
			return
		}
		setSubmitting(true)
		try {
			await rpc.addTask({ title: trimmed, priority })
			if (!mountedRef.current) return
			setTitle('')
			await refreshTasks({ silent: true })
		} catch (error) {
			if (!mountedRef.current) return
			setError(rpcErrorMessage(error, '无法新增任务'))
		} finally {
			if (mountedRef.current) {
				setSubmitting(false)
			}
		}
	}

	const handleToggleStatus = async (task: PluginTask) => {
		setUpdatingId(task.id)
		try {
			await rpc.updateTaskStatus(task.id, nextStatus(task.status))
			await refreshTasks({ silent: true })
		} catch (error) {
			if (!mountedRef.current) return
			setError(rpcErrorMessage(error, '无法更新任务状态'))
		} finally {
			if (mountedRef.current) {
				setUpdatingId(null)
			}
		}
	}

	const handleClearDone = async () => {
		setUpdatingId('clear')
		try {
			await rpc.clearFinishedTasks()
			await refreshTasks({ silent: true })
		} catch (error) {
			if (!mountedRef.current) return
			setError(rpcErrorMessage(error, '无法清理已完成任务'))
		} finally {
			if (mountedRef.current) {
				setUpdatingId(null)
			}
		}
	}

	return (
		<Paper withBorder radius="md" p="md">
			<Stack gap="sm">
				<Group justify="space-between">
					<Group gap="xs">
						<IconListCheck size={18} />
						<Text fw={600}>任务清单（第二个 Collection）</Text>
					</Group>
					<Group gap="xs">
						<Badge color="grape" variant="light">
							待办 {tasks.filter((t) => t.status !== 'done').length}
						</Badge>
						<Badge color="gray" variant="light">
							总数 {tasks.length}
						</Badge>
					</Group>
				</Group>
				{error && (
					<Alert color="red" radius="md" title="RPC 错误">
						{error}
					</Alert>
				)}
				<Group align="flex-end">
					<TextInput
						label="任务标题"
						placeholder="例如：补充更多数据用例"
						value={title}
						onChange={(event) => setTitle(event.currentTarget.value)}
						style={{ flex: 1 }}
					/>
					<Select
						label="优先级"
						value={priority}
						onChange={(value) => setPriority((value as PluginTask['priority']) ?? 'medium')}
						data={[
							{ value: 'high', label: '高' },
							{ value: 'medium', label: '中' },
							{ value: 'low', label: '低' },
						]}
						withCheckIcon
						checkIconPosition="right"
						allowDeselect={false}
						w={120}
					/>
					<Button onClick={handleAdd} loading={submitting} disabled={title.trim().length === 0}>
						新增任务
					</Button>
					<Button
						variant="subtle"
						color="gray"
						onClick={handleClearDone}
						loading={updatingId === 'clear'}
						disabled={!tasks.some((t) => t.status === 'done')}
					>
						清理已完成
					</Button>
				</Group>
				<Stack gap="xs">
					{tasks.map((task) => (
						<Paper key={task.id} withBorder radius="md" p="sm">
							<Group justify="space-between" align="flex-start">
								<Stack gap={4}>
									<Group gap="xs">
										<Badge size="xs" color={taskPriorityColor[task.priority]} variant="light">
											优先级：{taskPriorityLabel[task.priority]}
										</Badge>
										<Badge
											size="xs"
											color={
												task.status === 'done'
													? 'teal'
													: task.status === 'doing'
														? 'yellow'
														: 'gray'
											}
											variant="light"
										>
											状态：{taskStatusLabel[task.status]}
										</Badge>
									</Group>
									<Text fw={600}>{task.title}</Text>
									<Group gap={6}>
										{(Array.isArray(task.tags) ? task.tags : []).map((tag) => (
											<Badge key={tag} size="xs" color="grape" variant="outline">
												{tag}
											</Badge>
										))}
									</Group>
									<Text size="xs" c="dimmed">
										更新于 {formatTimestamp(task.updatedAt)}
									</Text>
								</Stack>
								<ActionIcon
									variant="light"
									color={task.status === 'done' ? 'gray' : 'grape'}
									onClick={() => handleToggleStatus(task)}
									loading={updatingId === task.id}
									aria-label="切换状态"
								>
									{task.status === 'done' ? (
										<IconCircleDashed size={16} />
									) : (
										<IconCircleCheck size={16} />
									)}
								</ActionIcon>
							</Group>
						</Paper>
					))}
					{!tasks.length && !loading && (
						<Text size="sm" c="dimmed">
							暂无任务，添加一个试试？
						</Text>
					)}
					{loading && (
						<Group gap="xs">
							<Loader size="sm" />
							<Text size="sm" c="dimmed">
								正在同步任务数据...
							</Text>
						</Group>
					)}
				</Stack>
			</Stack>
		</Paper>
	)
}

// 活动轨迹（来自持久化 Collection）
export function ActivityTimeline({ sse }: { sse: PluginSse }) {
	const [activity, setActivity] = useState<PluginActivity[]>([])
	const [loading, setLoading] = useState(true)
	const [error, setError] = useState<string | null>(null)
	const mountedRef = useRef(true)

	const { rpc } = usePluginApi()

	useEffect(() => {
		return () => {
			mountedRef.current = false
		}
	}, [])

	const fetchActivity = useCallback(async () => {
		return rpc.activity()
	}, [rpc])

	const refreshActivity = useCallback(async () => {
		setLoading(true)
		try {
			const items = await fetchActivity()
			if (!mountedRef.current) return
			setActivity(items)
			setError(null)
		} catch (error) {
			if (!mountedRef.current) return
			setError(rpcErrorMessage(error, '无法同步活动轨迹'))
		} finally {
			if (mountedRef.current) {
				setLoading(false)
			}
		}
	}, [fetchActivity])

	useEffect(() => {
		refreshActivity().catch(() => undefined)
	}, [refreshActivity])

	useEffect(() => {
		const off = sse.PluginWithUI.on(
			(msg) => {
				const payload = msg.payload
				if (!payload || typeof payload !== 'object') return
				const record = payload as { type?: unknown; activity?: unknown }

				if (record.type === 'cursor' && Array.isArray(record.activity)) {
					setActivity(record.activity as PluginActivity[])
					setLoading(false)
					return
				}
				if (record.type === 'sync' && Array.isArray(record.activity)) {
					setActivity(record.activity as PluginActivity[])
					setLoading(false)
				}
			},
			['cursor', 'sync'],
		)
		return () => off()
	}, [sse])

	return (
		<Paper withBorder radius="md" p="md">
			<Stack gap="sm">
				<Group gap="xs">
					<IconPlayerPlay size={18} />
					<Text fw={600}>活动轨迹（持久化 Collection）</Text>
				</Group>
				{error && (
					<Alert color="red" radius="md" title="RPC 错误">
						{error}
					</Alert>
				)}
				<Stack gap="xs">
					{activity.map((item) => (
						<Paper key={`${item.id}:${item.at}`} withBorder radius="md" p="sm">
							<Group justify="space-between">
								<Group gap="xs">
									<Badge size="xs" color={item.scope === 'note' ? 'grape' : 'cyan'}>
										{item.scope === 'note' ? '备注' : '任务'}
									</Badge>
									<Badge
										size="xs"
										color={item.action === 'removed' ? 'red' : 'green'}
										variant="light"
									>
										{item.action}
									</Badge>
									<Text size="sm">{item.detail}</Text>
								</Group>
								<Text size="xs" c="dimmed">
									{formatTimestamp(item.at)}
								</Text>
							</Group>
						</Paper>
					))}
					{!activity.length && !loading && (
						<Text size="sm" c="dimmed">
							暂无活动记录，尝试新增备注或任务。
						</Text>
					)}
					{loading && (
						<Group gap="xs">
							<Loader size="sm" />
							<Text size="sm" c="dimmed">
								正在同步活动轨迹...
							</Text>
						</Group>
					)}
				</Stack>
			</Stack>
		</Paper>
	)
}

// 插件备注面板（调用 PluginWithUI RPC）
export function NotesPanel({ sse }: { sse: PluginSse }) {
	const [notes, setNotes] = useState<PluginNote[]>([])
	const [message, setMessage] = useState('')
	const [loading, setLoading] = useState(true)
	const [submitting, setSubmitting] = useState(false)
	const [removingId, setRemovingId] = useState<string | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [formError, setFormError] = useState<string | null>(null)
	const mountedRef = useRef(true)

	const { rpc } = usePluginApi()

	useEffect(() => {
		return () => {
			mountedRef.current = false
		}
	}, [])

	const fetchNotes = useCallback(async () => {
		return rpc.notes()
	}, [rpc])

	const refreshNotes = useCallback(
		async (options?: { silent?: boolean }) => {
			if (!options?.silent) {
				setLoading(true)
			}
			try {
				const list = await fetchNotes()
				if (!mountedRef.current) {
					return
				}
				setNotes(list)
				setError(null)
			} catch (error) {
				if (!mountedRef.current) {
					return
				}
				setError(rpcErrorMessage(error, '无法加载插件备注'))
				throw error
			} finally {
				if (!options?.silent && mountedRef.current) {
					setLoading(false)
				}
			}
		},
		[fetchNotes],
	)

	useEffect(() => {
		refreshNotes().catch(() => undefined)
	}, [refreshNotes])

	// SSE 实时同步：无需传 namespaces，直接点出插件命名空间
	useEffect(() => {
		const off = sse.PluginWithUI.on(
			(msg) => {
				const payload = msg.payload
				if (!payload || typeof payload !== 'object') return

				const record = payload as { type?: unknown; notes?: unknown }

				if (record.type === 'cursor' && Array.isArray(record.notes)) {
					setNotes(record.notes as PluginNote[])
					setLoading(false)
					return
				}

				if (record.type === 'sync' && Array.isArray(record.notes)) {
					setNotes(record.notes as PluginNote[])
					setLoading(false)
					return
				}
				if (record.type === 'ready') {
					setLoading(false)
					return
				}
				if (record.type === 'tick') {
					return
				}

				setNotes((prev) => [payload as PluginNote, ...prev].slice(0, 8))
				setLoading(false)
			},
			['cursor', 'sync', 'note', 'ready', 'tick'],
		)

		return () => off()
	}, [sse])

	const handleAdd = async () => {
		const text = message.trim()
		if (text.length === 0) {
			setFormError('请输入要记录的内容')
			return
		}
		setFormError(null)
		setSubmitting(true)
		try {
			await rpc.addNote(text)
			if (!mountedRef.current) {
				return
			}
			setMessage('')
			await refreshNotes({ silent: true })
		} catch (error) {
			if (!mountedRef.current) {
				return
			}
			setError(rpcErrorMessage(error, '无法新增备注'))
		} finally {
			if (mountedRef.current) setSubmitting(false)
		}
	}

	const handleRemove = async (id: string) => {
		setRemovingId(id)
		try {
			await rpc.removeNote(id)
			await refreshNotes({ silent: true })
		} catch (error) {
			if (!mountedRef.current) {
				return
			}
			setError(rpcErrorMessage(error, '无法删除备注'))
		} finally {
			if (mountedRef.current) {
				setRemovingId(null)
			}
		}
	}

	return (
		<Paper withBorder radius="md" p="md">
			<Stack gap="sm">
				<Group justify="space-between">
					<Group gap="xs">
						<IconMessage2 size={18} />
						<Text fw={600}>插件专属备注</Text>
					</Group>
					<Badge color="grape" variant="light">
						{notes.length} 条
					</Badge>
				</Group>
				{error && (
					<Alert color="red" radius="md" title="RPC 错误">
						{error}
					</Alert>
				)}
				<Textarea
					placeholder="记录一条备注，方便团队成员了解插件运行状况..."
					value={message}
					minRows={2}
					onChange={(event) => setMessage(event.currentTarget.value)}
					autosize
				/>
				{formError && (
					<Text size="xs" c="red">
						{formError}
					</Text>
				)}
				<Group justify="space-between" align="center">
					<Text size="xs" c="dimmed">
						{loading ? '正在同步最新记录...' : '展示最近 8 条记录'}
					</Text>
					<Button
						size="xs"
						onClick={handleAdd}
						loading={submitting}
						disabled={message.trim().length === 0}
					>
						新增备注
					</Button>
				</Group>
				<Stack gap="xs">
					{notes.map((note) => (
						<Paper key={note.id} withBorder radius="md" p="sm">
							<Group justify="space-between" align="flex-start">
								<Text size="sm">{note.message}</Text>
								<ActionIcon
									variant="subtle"
									color="red"
									size="sm"
									onClick={() => handleRemove(note.id)}
									disabled={removingId === note.id}
									aria-label="删除备注"
								>
									{removingId === note.id ? <Loader size={14} /> : <IconTrash size={14} />}
								</ActionIcon>
							</Group>
							<Text size="xs" c="dimmed">
								{formatTimestamp(note.createdAt)} · {note.author === 'system' ? '系统' : '来自 UI'}
							</Text>
						</Paper>
					))}
					{!notes.length && !loading && (
						<Text size="sm" c="dimmed">
							暂无备注，快来添加第一条吧。
						</Text>
					)}
				</Stack>
			</Stack>
		</Paper>
	)
}

// 实时 SSE 活动摘要（展示 logs 与插件命名空间事件）
export function LiveSseActivity({ sse }: { sse: PluginSse }) {
	const [items, setItems] = useState<
		Array<{ key: string; label: string; detail?: string; time: string; color: string }>
	>([])
	const [connected, setConnected] = useState(false)
	const [lastTick, setLastTick] = useState<string | null>(null)

	useEffect(() => {
		const offOpen = sse.onOpen(() => setConnected(true))
		const offError = sse.onError(() => setConnected(false))

		const offLogs = sse.logs.onAny((msg) => {
			const payload = msg.payload
			const record =
				payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : null
			const time = typeof record?.time === 'string' ? record.time : new Date().toLocaleTimeString()
			const label = typeof record?.msg === 'string' ? record.msg : '日志'
			const detail = typeof record?.name === 'string' ? record.name : undefined
			setItems((prev) =>
				[
					{
						key: `log-${time || Date.now()}-${prev.length}`,
						label,
						detail,
						time,
						color: 'cyan',
					},
					...prev,
				].slice(0, 8),
			)
		})

		const offPlugin = sse.PluginWithUI.on(
			(msg) => {
				const payload = msg.payload
				const record =
					payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : null
				const type = typeof record?.type === 'string' ? record.type : ''
				const now = typeof record?.now === 'number' ? record.now : null
				const message = typeof record?.message === 'string' ? record.message : undefined
				const author = typeof record?.author === 'string' ? record.author : undefined
				const tag =
					type === 'sync'
						? '同步'
						: type === 'cursor'
							? '光标'
							: type === 'ready'
								? '就绪'
								: type === 'tick'
									? '时间'
									: '备注'
				const label =
					type === 'ready'
						? '插件 SSE 就绪'
						: type === 'tick' && now != null
							? `当前时间 ${new Date(now).toLocaleTimeString()}`
							: `[${tag}] ${message ?? (type || '更新')}`
				if (type === 'tick' && now != null) {
					setLastTick(new Date(now).toLocaleTimeString())
				}

				setItems((prev) =>
					[
						{
							key: `sse-${msg.event}-${Date.now()}-${prev.length}`,
							label,
							detail: author ?? type,
							time: new Date().toLocaleTimeString(),
							color: tag === '同步' ? 'grape' : tag === '光标' ? 'violet' : 'teal',
						},
						...prev,
					].slice(0, 8),
				)
			},
			['sync', 'cursor', 'note'],
		)

		const offExt = sse.extensions?.on?.((msg) => {
			const payload = msg.payload
			const record =
				payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : null
			const version =
				typeof record?.version === 'number' || typeof record?.version === 'string'
					? String(record.version)
					: String(Date.now())
			const type = typeof record?.type === 'string' ? record.type : '更新'
			const pluginName = typeof record?.pluginName === 'string' ? record.pluginName : undefined
			setItems((prev) =>
				[
					{
						key: `ext-${version}-${prev.length}`,
						label: `[扩展] ${type}`,
						detail: pluginName,
						time: new Date().toLocaleTimeString(),
						color: 'yellow',
					},
					...prev,
				].slice(0, 8),
			)
		})

		return () => {
			offLogs()
			offPlugin()
			offExt?.()
			offOpen()
			offError()
		}
	}, [sse])

	return (
		<Paper withBorder radius="md" p="md">
			<Stack gap="sm">
				<Group justify="space-between">
					<Group gap="xs">
						<IconDashboard size={18} />
						<Text fw={600}>实时活动 (SSE)</Text>
					</Group>
					<Badge color="cyan" variant="light">
						最近 {items.length} 条
					</Badge>
				</Group>
				{lastTick && (
					<Text size="xs" c="dimmed">
						最近心跳：{lastTick}
					</Text>
				)}
				<Stack gap="xs">
					{items.map((item) => (
						<Paper key={item.key} withBorder radius="md" p="sm">
							<Group justify="space-between" align="center">
								<Group gap="sm">
									<Badge size="xs" color={item.color}>
										{item.time}
									</Badge>
									<Text size="sm" fw={600}>
										{item.label}
									</Text>
								</Group>
								{item.detail && (
									<Text size="xs" c="dimmed">
										{item.detail}
									</Text>
								)}
							</Group>
						</Paper>
					))}
					{!items.length && (
						<Text size="sm" c="dimmed">
							{connected ? '等待实时事件...' : 'SSE 连接中...'}
						</Text>
					)}
				</Stack>
			</Stack>
		</Paper>
	)
}

// 插件信息卡片
export function InfoCard({ ctx }: { ctx: PluginExtensionContext }) {
	const pluginName = ctx.pluginName
	const [overview, setOverview] = useState<PluginOverview | null>(null)
	const [statusMessage, setStatusMessage] = useState(`正在同步 ${pluginName} 状态...`)
	const [loading, setLoading] = useState(true)
	const mountedRef = useRef(true)
	const theme = useMantineTheme()
	const { colorScheme } = useMantineColorScheme()
	const cardBg = colorScheme === 'dark' ? theme.colors.dark[6] : theme.colors.grape[0]

	const { rpc } = usePluginApi()

	useEffect(() => {
		return () => {
			mountedRef.current = false
		}
	}, [])

	const refreshOverview = useCallback(async () => {
		try {
			const current = await rpc.overview()
			if (!mountedRef.current) {
				return
			}
			setOverview(current)
			setStatusMessage(`运行中，已持续 ${formatDuration(current.uptimeMs)}`)
		} catch (error) {
			if (!mountedRef.current) {
				return
			}
			setStatusMessage(`状态异常：${rpcErrorMessage(error, '无法获取插件状态')}`)
		} finally {
			if (mountedRef.current) setLoading(false)
		}
	}, [])

	useEffect(() => {
		const timer = setInterval(() => {
			refreshOverview().catch(() => undefined)
		}, 10_000)
		refreshOverview().catch(() => undefined)
		return () => {
			clearInterval(timer)
		}
	}, [refreshOverview])

	const handleManualRefresh = () => {
		setLoading(true)
		refreshOverview().catch(() => undefined)
	}

	return (
		<Paper withBorder p="sm" radius="md" bg={cardBg}>
			<Stack gap="xs">
				<Group key="header" gap="xs" justify="space-between" align="center">
					<Group key="title" gap="xs">
						<IconRocket key="icon" size={16} />
						<Text key="label" size="sm" fw={500}>
							{pluginName} 状态
						</Text>
					</Group>
					<Button
						key="refresh"
						size="compact-xs"
						variant="light"
						color="grape"
						onClick={handleManualRefresh}
						loading={loading}
					>
						刷新
					</Button>
				</Group>
				<Text key="status" size="xs" c="dimmed">
					{statusMessage}
				</Text>
				<Group key="badges" gap="xs">
					<Badge key="status" color="grape" variant="light">
						{overview?.status ?? '未连接'}
					</Badge>
					<Badge key="notes" color="violet" variant="light">
						备注 {overview?.noteCount ?? 0}
					</Badge>
					<Badge key="tasks" color="cyan" variant="light">
						任务 {overview?.taskCount ?? 0}
					</Badge>
					<Badge key="version" size="xs" color="gray" variant="light">
						版本 {overview?.version ?? 'dev'}
					</Badge>
				</Group>
				{overview?.lastHeartbeat && (
					<Text key="heartbeat" size="xs" c="dimmed">
						最近心跳：{formatTimestamp(overview.lastHeartbeat)}
					</Text>
				)}
			</Stack>
		</Paper>
	)
}

// Dashboard 页面
export function Dashboard() {
	return (
		<Stack gap="lg" p="lg">
			<Group gap="sm">
				<IconDashboard size={24} />
				<Text size="xl" fw={700}>
					PluginWithUI Dashboard
				</Text>
			</Group>

			<Paper withBorder p="lg" radius="md">
				<Stack gap="md">
					<Text>这是一个由插件注入的独立页面。 通过路由扩展，插件可以添加完整的页面到应用中。</Text>
					<Text c="dimmed" size="sm">
						路径: /ext/PluginWithUI/dashboard
					</Text>
				</Stack>
			</Paper>
		</Stack>
	)
}
