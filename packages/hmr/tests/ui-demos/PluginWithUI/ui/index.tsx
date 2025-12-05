// packages/hmr/tests/plugins/ui-demos/PluginWithUI/ui/index.tsx
// 插件 UI 扩展入口模块

import {
	ActionIcon,
	Alert,
	Badge,
	Button,
	Group,
	Loader,
	Paper,
	Stack,
	Text,
	Textarea,
	useMantineColorScheme,
	useMantineTheme,
} from '@mantine/core'
import {
	definePluginUIModule,
	type ExtensionContext,
	type HmrWebClient,
	rpcErrorMessage,
	webClient,
} from '@pluxel/hmr/web'
import { IconDashboard, IconMessage2, IconRocket, IconTrash } from '@tabler/icons-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

type PluginWithUIRpc = HmrWebClient['rpc']['PluginWithUI']
type PluginOverview = Awaited<ReturnType<PluginWithUIRpc['overview']>>
type PluginNote = Awaited<ReturnType<PluginWithUIRpc['notes']>>[number]

const formatDuration = (ms: number): string => {
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

const formatTimestamp = (value: number): string => {
	return new Date(value).toLocaleTimeString()
}

// ─────────────────────────────────────────────────────────
// Header 按钮组件
// ─────────────────────────────────────────────────────────
function HeaderButton({ ctx }: { ctx: ExtensionContext }) {
	return (
		<Button variant="light" size="xs" leftSection={<IconRocket size={14} />} color="grape">
			PluginWithUI
		</Button>
	)
}

// ─────────────────────────────────────────────────────────
// 实时时间（来自插件 SSE tick）
// ─────────────────────────────────────────────────────────
type RealTimeTickerProps = { sse: ReturnType<typeof webClient.createSse> }
function RealTimeTicker({ sse }: RealTimeTickerProps) {
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

// ─────────────────────────────────────────────────────────
// 自定义 Tab 内容
// ─────────────────────────────────────────────────────────
function CustomTab({ ctx }: { ctx: ExtensionContext }) {
	const sharedSse = useMemo(
		() => webClient.createSse({ namespaces: ['logs', 'extensions', ctx.pluginName] }),
		[ctx.pluginName],
	)

	useEffect(() => {
		return () => sharedSse.close()
	}, [sharedSse])

	return (
		<Stack gap="md">
			<Text size="lg" fw={600}>
				自定义配置面板
			</Text>
			<Text c="dimmed">
				这是由 PluginWithUI 插件注入的自定义 Tab 内容。 你可以在这里添加任何自定义的配置界面。
			</Text>
			<NotesPanel sse={sharedSse} />
			<RealTimeTicker sse={sharedSse} />
			<LiveSseActivity sse={sharedSse} />
			<Paper withBorder p="md" radius="md">
				<Group justify="space-between">
					<Text>当前插件</Text>
					<Badge color="grape">{ctx.pluginName}</Badge>
				</Group>
			</Paper>
		</Stack>
	)
}

// ─────────────────────────────────────────────────────────
// 插件信息卡片
// ─────────────────────────────────────────────────────────
function InfoCard({ ctx }: { ctx: ExtensionContext }) {
	const [overview, setOverview] = useState<PluginOverview | null>(null)
	const [statusMessage, setStatusMessage] = useState(`正在同步 ${ctx.pluginName} 状态...`)
	const [loading, setLoading] = useState(true)
	const mountedRef = useRef(true)
	const theme = useMantineTheme()
	const { colorScheme } = useMantineColorScheme()
	const cardBg = colorScheme === 'dark' ? theme.colors.dark[6] : theme.colors.grape[0]

	useEffect(() => {
		return () => {
			mountedRef.current = false
		}
	}, [])

	const refreshOverview = useCallback(async () => {
		try {
			const current = await webClient.rpc.PluginWithUI.overview()
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
			if (!mountedRef.current) {
				return
			}
			setLoading(false)
		}
	}, [])

	useEffect(() => {
		const timer = setInterval(() => {
			refreshOverview().catch(() => {})
		}, 10_000)
		refreshOverview().catch(() => {})
		return () => {
			clearInterval(timer)
		}
	}, [refreshOverview])

	const handleManualRefresh = () => {
		setLoading(true)
		refreshOverview().catch(() => {})
	}

	return (
		<Paper withBorder p="sm" radius="md" bg={cardBg}>
			<Stack gap="xs">
				<Group key="header" gap="xs" justify="space-between" align="center">
					<Group gap="xs">
						<IconRocket size={16} />
						<Text size="sm" fw={500}>
							{ctx.pluginName} 状态
						</Text>
					</Group>
					<Button
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

// ─────────────────────────────────────────────────────────
// Dashboard 页面
// ─────────────────────────────────────────────────────────
function Dashboard() {
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

// ─────────────────────────────────────────────────────────
// 插件备注面板（调用 PluginWithUI RPC）
// ─────────────────────────────────────────────────────────
type NotesPanelProps = { sse: ReturnType<typeof webClient.createSse> }

function NotesPanel({ sse }: NotesPanelProps) {
	const [notes, setNotes] = useState<PluginNote[]>([])
	const [message, setMessage] = useState('')
	const [loading, setLoading] = useState(true)
	const [submitting, setSubmitting] = useState(false)
	const [removingId, setRemovingId] = useState<number | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [formError, setFormError] = useState<string | null>(null)
	const mountedRef = useRef(true)

	useEffect(() => {
		return () => {
			mountedRef.current = false
		}
	}, [])

	const fetchNotes = useCallback(async () => {
		return webClient.rpc.PluginWithUI.notes()
	}, [])

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
		refreshNotes().catch(() => {})
	}, [refreshNotes])

	// SSE 实时同步：无需传 namespaces，直接点出插件命名空间
	useEffect(() => {
		const off = sse.PluginWithUI.on(
			(msg) => {
				const payload = msg.payload as PluginNote | { type: 'sync'; notes: PluginNote[] }
				if (payload && typeof payload === 'object' && 'type' in payload) {
					if (payload.type === 'sync') {
						setNotes(payload.notes)
						setLoading(false)
						return
					}
					if (payload.type === 'ready') {
						setLoading(false)
						return
					}
					if (payload.type === 'tick') {
						// ignore in NotesPanel
						return
					}
				}
				if (!payload || typeof payload !== 'object') return
				setNotes((prev) => [payload as PluginNote, ...prev].slice(0, 8))
				setLoading(false)
			},
			['sync', 'note', 'ready', 'tick'],
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
			await webClient.rpc.PluginWithUI.addNote(text)
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
			if (!mountedRef.current) {
				return
			}
			setSubmitting(false)
		}
	}

	const handleRemove = async (id: number) => {
		setRemovingId(id)
		try {
			await webClient.rpc.PluginWithUI.removeNote(id)
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

// ─────────────────────────────────────────────────────────
// 实时 SSE 活动摘要（展示 logs 与插件命名空间事件）
// ─────────────────────────────────────────────────────────
type LiveSseActivityProps = { sse: ReturnType<typeof webClient.createSse> }

function LiveSseActivity({ sse }: LiveSseActivityProps) {
	const [items, setItems] = useState<
		Array<{ key: string; label: string; detail?: string; time: string; color: string }>
	>([])
	const [connected, setConnected] = useState(false)
	const [lastTick, setLastTick] = useState<string | null>(null)

	useEffect(() => {
		const offOpen = sse.onOpen(() => setConnected(true))
		const offError = sse.onError(() => setConnected(false))

		const offLogs = sse.logs.onAny((msg) => {
			const payload = msg.payload as any
			setItems((prev) =>
				[
					{
						key: `log-${payload?.time ?? Date.now()}-${prev.length}`,
						label: payload?.msg ?? '日志',
						detail: payload?.name,
						time: payload?.time ?? new Date().toLocaleTimeString(),
						color: 'cyan',
					},
					...prev,
				].slice(0, 8),
			)
		})

		const offPlugin = sse.PluginWithUI.on(
			(msg) => {
				const payload = msg.payload as any
				const tag =
					payload?.type === 'sync'
						? '同步'
						: payload?.type === 'ready'
							? '就绪'
							: payload?.type === 'tick'
								? '时间'
								: '备注'
				const label =
					payload?.type === 'ready'
						? '插件 SSE 就绪'
						: payload?.type === 'tick'
							? `当前时间 ${new Date(payload.now).toLocaleTimeString()}`
							: `[${tag}] ${payload?.message ?? payload?.type ?? '更新'}`
				if (payload?.type === 'tick' && typeof payload.now === 'number') {
					setLastTick(new Date(payload.now).toLocaleTimeString())
				}

				setItems((prev) =>
					[
						{
							key: `sse-${msg.event}-${Date.now()}-${prev.length}`,
							label,
							detail: payload?.author ?? payload?.type,
							time: new Date().toLocaleTimeString(),
							color: tag === '同步' ? 'grape' : 'teal',
						},
						...prev,
					].slice(0, 8),
				)
			},
			['sync', 'note'],
		)

		const offExt = sse.extensions?.on?.((msg) => {
			const payload = msg.payload as any
			setItems((prev) =>
				[
					{
						key: `ext-${payload?.version ?? Date.now()}-${prev.length}`,
						label: `[扩展] ${payload?.type ?? '更新'}`,
						detail: payload?.pluginName,
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

// ─────────────────────────────────────────────────────────
// 模块导出
// ─────────────────────────────────────────────────────────
const module = definePluginUIModule({
	extensions: [
		{
			point: 'header:actions',
			meta: { priority: 100, id: 'PluginWithUI:header:actions' },
			Component: HeaderButton,
		},
		{
			point: 'plugin:tabs',
			meta: {
				priority: 10,
				label: '自定义面板',
				id: 'PluginWithUI:plugin:tabs',
			},
			when: (ctx) => ctx.pluginName === 'PluginWithUI',
			Component: CustomTab,
		},
		{
			point: 'plugin:info',
			meta: { priority: 5, requireRunning: true, id: 'PluginWithUI:plugin:info' },
			when: (ctx) => ctx.pluginName === 'PluginWithUI' && ctx.isPluginRunning === true,
			Component: InfoCard,
		},
	],
	routes: [
		{
			definition: {
				path: '/dashboard',
				title: 'PluginWithUI Dashboard',
				icon: <IconDashboard size={18} stroke={1.7} />,
				addToNav: true,
				navPriority: 50,
			},
			Component: Dashboard,
		},
	],
	setup() {
		console.log('[PluginWithUI] UI module loaded')
	},
})

export default module
