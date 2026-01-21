// packages/hmr/tests/demo/PluginWithUI/ui/components.tsx
import {
	ActionIcon,
	Alert,
	Badge,
	Button,
	Card,
	Code,
	Group,
	Loader,
	ScrollArea,
	Stack,
	Text,
	Textarea,
	TextInput,
	Title,
} from '@mantine/core'
import type { PluginExtensionContext } from '@pluxel/hmr/web'
import { rpcErrorMessage, useExtensionContext } from '@pluxel/hmr/web'
import {
	IconActivity,
	IconCirclePlus,
	IconRefresh,
	IconRestore,
	IconServer,
	IconWaveSine,
} from '@tabler/icons-react'
import { useCallback, useEffect, useMemo, useState } from 'react'

type RuntimeApi = Readonly<{
	pluginName: string
	ui: PluginExtensionContext['services']['hmr']['ui']['PluginWithUI']
	sse: PluginExtensionContext['services']['hmr']['sse']
}>

function useRuntime(): RuntimeApi {
	const ctx = useExtensionContext('plugin')
	const pluginName = ctx.pluginName
	const hmr = ctx.services.hmr
	return useMemo(
		() => ({
			pluginName,
			ui: hmr.ui.PluginWithUI,
			// Use the shared host SSE connection to avoid exhausting browser connection limits.
			sse: hmr.sse,
		}),
		[pluginName, hmr],
	)
}

type PluginWithUISse = RuntimeApi['sse']
type PluginWithUIRpc = RuntimeApi['ui']

function useLiveConnectionState(sse: PluginWithUISse) {
	const [connected, setConnected] = useState(false)
	useEffect(() => {
		const offOpen = sse.onOpen(() => setConnected(true))
		const offError = sse.onError(() => setConnected(false))
		return () => {
			offOpen()
			offError()
		}
	}, [sse])
	return connected
}

export function OverviewPanel() {
	const { pluginName, ui, sse } = useRuntime()
	type Status = Awaited<ReturnType<PluginWithUIRpc['status']>>
	const connected = useLiveConnectionState(sse)
	const [status, setStatus] = useState<Status | null>(null)
	const [tick, setTick] = useState<number | null>(null)
	const [loading, setLoading] = useState(true)
	const [error, setError] = useState<string | null>(null)

	const refresh = useCallback(async () => {
		setLoading(true)
		try {
			const res = await ui.status()
			setStatus(res)
			setError(null)
		} catch (e) {
			setError(rpcErrorMessage(e, '无法获取状态'))
		} finally {
			setLoading(false)
		}
	}, [ui])

	useEffect(() => {
		void refresh()
	}, [refresh])

	useEffect(() => {
		const off = sse.PluginWithUI.on(
			(msg) => {
				const payload = msg.payload
				if (payload.type === 'tick') return void setTick(payload.now)
				if (payload.type === 'ready' || payload.type === 'snapshot' || payload.type === 'event') {
					setStatus(payload.status)
					setLoading(false)
					setError(null)
				}
			},
			['tick', 'ready', 'snapshot', 'event'],
		)
		return () => off()
	}, [sse])

	const now = tick ?? Date.now()
	const uptimeSeconds = status ? Math.max(0, Math.floor((now - status.startedAt) / 1000)) : 0

	return (
		<Stack gap="md">
			<Group justify="space-between" align="center">
				<Group gap="xs">
					<IconServer size={18} />
					<Title order={4}>PluginWithUI 概览</Title>
				</Group>
				<Group gap="xs">
					<Badge variant="light" color={connected ? 'teal' : 'gray'}>
						{connected ? 'SSE 已连接' : 'SSE 未连接'}
					</Badge>
					<ActionIcon variant="light" onClick={() => void refresh()} aria-label="刷新状态">
						<IconRefresh size={16} />
					</ActionIcon>
				</Group>
			</Group>

			{error ? (
				<Alert color="red" title="错误">
					{error}
				</Alert>
			) : null}

			{loading && !status ? (
				<Group gap="xs">
					<Loader size="sm" />
					<Text size="sm" c="dimmed">
						正在加载状态…
					</Text>
				</Group>
			) : null}

			<Card withBorder radius="md" p="md">
				<Stack gap="xs">
					<Text size="sm">
						插件：<Code>{pluginName}</Code>
					</Text>
					<Text size="sm">
						运行时长：<Code>{uptimeSeconds}s</Code>
					</Text>
					<Text size="sm">
						计数器：<Code>{status?.counter ?? 0}</Code>
					</Text>
					<Text size="sm">
						事件数：<Code>{status?.eventCount ?? 0}</Code>
					</Text>
					<Text size="sm">
						最近心跳：<Code>{tick ? new Date(tick).toLocaleTimeString() : '—'}</Code>
					</Text>
				</Stack>
			</Card>

			<Group>
				<Button
					leftSection={<IconCirclePlus size={16} />}
					onClick={() =>
						ui
							.increment(1)
							.then(() => setError(null))
							.catch((e: unknown) => setError(rpcErrorMessage(e, '无法执行 +1')))
					}
				>
					+1
				</Button>
				<Button
					variant="light"
					leftSection={<IconRestore size={16} />}
					onClick={() =>
						ui
							.resetCounter()
							.then(() => setError(null))
							.catch((e: unknown) => setError(rpcErrorMessage(e, '无法重置计数器')))
					}
				>
					重置
				</Button>
			</Group>
		</Stack>
	)
}

export function EventsPanel() {
	const { ui, sse } = useRuntime()
	type DemoEvent = Awaited<ReturnType<PluginWithUIRpc['events']>>[number]
	const [events, setEvents] = useState<DemoEvent[]>([])
	const [loading, setLoading] = useState(true)
	const [error, setError] = useState<string | null>(null)
	const [text, setText] = useState('')

	const refresh = useCallback(async () => {
		setLoading(true)
		try {
			const res = await ui.events(50)
			setEvents(res)
			setError(null)
		} catch (e) {
			setError(rpcErrorMessage(e, '无法获取事件列表'))
		} finally {
			setLoading(false)
		}
	}, [ui])

	useEffect(() => {
		void refresh()
	}, [refresh])

	useEffect(() => {
		const off = sse.PluginWithUI.on(
			(msg) => {
				const payload = msg.payload
				if (payload.type === 'snapshot') {
					setEvents(payload.events)
					setLoading(false)
					setError(null)
					return
				}
				if (payload.type === 'event') {
					setEvents((prev) => [payload.event, ...prev].slice(0, 50))
					return
				}
				if (payload.type === 'cleared') return void setEvents([])
			},
			['snapshot', 'event', 'cleared'],
		)
		return () => off()
	}, [sse])

	const addNote = async () => {
		const message = text.trim()
		if (!message) return
		setText('')
		try {
			await ui.addNote(message)
		} catch (e) {
			setError(rpcErrorMessage(e, '无法添加事件'))
		}
	}

	return (
		<Stack gap="md">
			<Group justify="space-between">
				<Group gap="xs">
					<IconActivity size={18} />
					<Title order={4}>事件流</Title>
				</Group>
				<Group gap="xs">
					<ActionIcon variant="light" onClick={() => void refresh()} aria-label="刷新事件列表">
						<IconRefresh size={16} />
					</ActionIcon>
					<Button
						variant="light"
						color="red"
						onClick={(): void => {
							void ui.clearEvents().catch((): void => {})
						}}
					>
						清空
					</Button>
				</Group>
			</Group>

			{error ? (
				<Alert color="red" title="错误">
					{error}
				</Alert>
			) : null}

			<Group align="flex-end">
				<TextInput
					style={{ flex: 1 }}
					label="发送一条 UI 事件"
					placeholder="例如：用户点击了按钮 / RPC 返回 OK …"
					value={text}
					onChange={(e) => setText(e.currentTarget.value)}
				/>
				<Button onClick={() => void addNote()} disabled={!text.trim()}>
					发送
				</Button>
			</Group>

			<Card withBorder radius="md" p={0}>
				<ScrollArea h={320} type="auto" scrollbarSize={10} offsetScrollbars>
					<Stack gap="xs" p="sm">
						{loading ? (
							<Group gap="xs">
								<Loader size="sm" />
								<Text size="sm" c="dimmed">
									正在获取事件…
								</Text>
							</Group>
						) : null}
						{!loading && events.length === 0 ? (
							<Text size="sm" c="dimmed">
								暂无事件，先发一条试试。
							</Text>
						) : null}
						{events.map((ev) => (
							<Card key={ev.id} withBorder radius="md" p="sm">
								<Group justify="space-between" align="flex-start">
									<Stack gap={2}>
										<Group gap="xs">
											<Badge size="xs" variant="light">
												{ev.kind}
											</Badge>
											<Text size="xs" c="dimmed">
												{new Date(ev.at).toLocaleTimeString()}
											</Text>
										</Group>
										<Text size="sm">{ev.message}</Text>
									</Stack>
								</Group>
							</Card>
						))}
					</Stack>
				</ScrollArea>
			</Card>
		</Stack>
	)
}

export function StreamsPanel() {
	const { sse } = useRuntime()
	const connected = useLiveConnectionState(sse)
	const [lines, setLines] = useState<Array<{ key: string; text: string }>>([])

	useEffect(() => {
		const off = sse.PluginWithUI.onAny((msg) => {
			const payload = msg.payload
			const text =
				typeof payload === 'object' && payload && 'type' in payload
					? `${String((payload as any).type)}`
					: msg.event
			setLines((prev) => [{ key: `${Date.now()}-${prev.length}`, text }, ...prev].slice(0, 50))
		})
		return () => off()
	}, [sse])

	return (
		<Stack gap="md">
			<Group justify="space-between">
				<Group gap="xs">
					<IconWaveSine size={18} />
					<Title order={4}>SSE / Logs</Title>
				</Group>
				<Badge variant="light" color={connected ? 'teal' : 'gray'}>
					{connected ? '连接中' : '未连接'}
				</Badge>
			</Group>

				<Text size="sm" c="dimmed">
					这里订阅本插件的 SSE 命名空间（`PluginWithUI`），展示最近收到的事件名（最多 50 条）。
				</Text>

			<Card withBorder radius="md" p={0}>
				<ScrollArea h={320} type="auto" scrollbarSize={10} offsetScrollbars>
					<Stack gap={6} p="sm">
						{lines.length === 0 ? (
							<Text size="sm" c="dimmed">
								暂无日志，等待插件或宿主输出…
							</Text>
						) : null}
						{lines.map((l) => (
							<Text
								key={l.key}
								size="xs"
								style={{
									fontFamily:
										'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
								}}
							>
								{l.text}
							</Text>
						))}
					</Stack>
				</ScrollArea>
			</Card>
		</Stack>
	)
}

export function RoutePage() {
	const { pluginName } = useRuntime()
	return (
		<Stack gap="md">
			<Title order={3}>插件路由页面</Title>
			<Text size="sm" c="dimmed">
				这是插件提供的独立页面路由，用于演示 `routes` 能力。插件名：<Code>{pluginName}</Code>
			</Text>
			<Textarea
				label="任意输入（纯 UI 示例）"
				placeholder="这里不调用后端，仅展示 UI 能力…"
				minRows={4}
			/>
		</Stack>
	)
}
