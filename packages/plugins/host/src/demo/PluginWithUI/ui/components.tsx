// Main UI panels for the custom UI demo.

import {
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
import { rpcErrorMessage } from '@pluxel/runtime/web/ui'
import {
	IconActivity,
	IconArrowLeft,
	IconCirclePlus,
	IconRestore,
	IconServer,
	IconWaveSine,
} from '@tabler/icons-react'
import { type ReactNode, useEffect, useState } from 'react'
import { plugin } from './runtime'

type PluginWithUIRuntime = ReturnType<typeof plugin.use>
type PluginWithUISseClient = PluginWithUIRuntime['transport']['sse']
type RpcAction = () => Promise<unknown>
type SsePayloadWithType = { type: unknown }

function useRpcError() {
	const [error, setError] = useState<string | null>(null)

	const run = async (action: RpcAction, fallbackMessage: string) => {
		try {
			await action()
			setError(null)
		} catch (error) {
			setError(rpcErrorMessage(error, fallbackMessage))
		}
	}

	return { error, run }
}

function useLiveConnectionState(sse: PluginWithUISseClient) {
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

function useLatestTick(app: PluginWithUIRuntime) {
	const [tick, setTick] = useState<number | null>(null)

	useEffect(() => {
		const off = app.sse.on((msg) => {
			if (msg.payload.type === 'tick') setTick(msg.payload.now)
		}, 'tick')
		return () => off()
	}, [app.sse])

	return tick
}

function pluginRouteHref(pluginName: string, path: string) {
	return `/plugins/${encodeURIComponent(pluginName)}${path}`
}

function panelTitle(icon: ReactNode, title: string) {
	return (
		<Group gap="xs">
			{icon}
			<Title order={4}>{title}</Title>
		</Group>
	)
}

function sseLineText(payload: unknown, fallback: string) {
	if (hasPayloadType(payload)) return String(payload.type)
	return fallback
}

function hasPayloadType(payload: unknown): payload is SsePayloadWithType {
	return Boolean(payload) && typeof payload === 'object' && 'type' in payload
}

export function OverviewPanel() {
	const app = plugin.use()
	const status = app.db.useDocById('status', 'status')
	const eventCount = app.db.useCount('events')
	const connected = useLiveConnectionState(app.transport.sse)
	const tick = useLatestTick(app)
	const { error, run } = useRpcError()

	const now = tick ?? Date.now()
	const uptimeSeconds = status ? Math.max(0, Math.floor((now - status.startedAt) / 1000)) : 0

	return (
		<Stack gap="md">
			<Group justify="space-between" align="center">
				{panelTitle(<IconServer size={18} />, 'PluginWithUI 概览')}
				<Group gap="xs">
					<Badge variant="light" color={connected ? 'teal' : 'gray'}>
						{connected ? 'SSE 已连接' : 'SSE 未连接'}
					</Badge>
				</Group>
			</Group>

			{error ? (
				<Alert color="red" title="错误">
					{error}
				</Alert>
			) : null}

			{!status ? (
				<Group gap="xs">
					<Loader size="sm" />
					<Text size="sm" c="dimmed">
						正在等待 signaldb 同步…
					</Text>
				</Group>
			) : null}

			<Card withBorder radius="md" p="md">
				<Stack gap="xs">
					<Text size="sm">
						插件：<Code>{app.pluginName}</Code>
					</Text>
					<Text size="sm">
						运行时长：<Code>{uptimeSeconds}s</Code>
					</Text>
					<Text size="sm">
						计数器：<Code>{status?.counter ?? 0}</Code>
					</Text>
					<Text size="sm">
						事件数：<Code>{eventCount}</Code>
					</Text>
					<Text size="sm">
						最近心跳：<Code>{tick ? new Date(tick).toLocaleTimeString() : '—'}</Code>
					</Text>
				</Stack>
			</Card>

			<Group>
				<Button
					leftSection={<IconCirclePlus size={16} />}
					onClick={() => void run(() => app.rpc.increment(1), '无法执行 +1')}
				>
					+1
				</Button>
				<Button
					variant="light"
					leftSection={<IconRestore size={16} />}
					onClick={() => void run(() => app.rpc.resetCounter(), '无法重置计数器')}
				>
					重置
				</Button>
			</Group>
		</Stack>
	)
}

export function EventsPanel() {
	const app = plugin.use()
	const eventsCollection = app.db.collection('events')
	const events = eventsCollection.useView()
	const recentEvents = eventsCollection.useLiveQuery((view) =>
		view.find({}, { sort: { at: -1 }, limit: 50 }),
	)
	const { error, run } = useRpcError()
	const [text, setText] = useState('')

	const addNote = async () => {
		const message = text.trim()
		if (!message) return
		await run(() => app.rpc.addNote(message), '无法添加事件')
		setText('')
	}

	return (
		<Stack gap="md">
			<Group justify="space-between">
				{panelTitle(<IconActivity size={18} />, '事件流')}
				<Group gap="xs">
					<Button
						variant="light"
						color="red"
						onClick={() => void run(() => app.rpc.clearEvents(), '无法清空事件')}
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
						{!events.ready && recentEvents.length === 0 ? (
							<Group gap="xs">
								<Loader size="sm" />
								<Text size="sm" c="dimmed">
									正在同步事件…
								</Text>
							</Group>
						) : null}
						{events.ready && events.items.length === 0 ? (
							<Text size="sm" c="dimmed">
								暂无事件，先发一条试试。
							</Text>
						) : null}
						{recentEvents.map((ev) => (
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
	const app = plugin.use()
	const connected = useLiveConnectionState(app.transport.sse)
	const [lines, setLines] = useState<Array<{ key: string; text: string }>>([])

	useEffect(() => {
		const off = app.sse.onAny((msg) => {
			const text = sseLineText(msg.payload, msg.event)
			setLines((prev) => [{ key: `${Date.now()}-${prev.length}`, text }, ...prev].slice(0, 50))
		})
		return () => off()
	}, [app.sse])

	return (
		<Stack gap="md">
			<Group justify="space-between">
				{panelTitle(<IconWaveSine size={18} />, 'SSE / Logs')}
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
									fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
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

type RoutePageProps = {
	frame?: 'shell' | 'standalone'
}

export function RoutePage({ frame = 'shell' }: RoutePageProps) {
	const app = plugin.use()
	const standalone = frame === 'standalone'
	return (
		<Stack gap="md" style={standalone ? { minHeight: '100dvh', padding: 24 } : undefined}>
			<Group justify="space-between" align="center">
				<Title order={3}>{standalone ? '插件 Standalone 页面' : '插件路由页面'}</Title>
				{standalone ? (
					<Button
						variant="light"
						size="xs"
						leftSection={<IconArrowLeft size={14} />}
						component="a"
						href={pluginRouteHref(app.pluginName, '/dashboard')}
					>
						返回宿主壳
					</Button>
				) : null}
			</Group>
			<Text size="sm" c="dimmed">
				这是插件提供的页面路由，用于演示 `routes` 能力。插件名：<Code>{app.pluginName}</Code>
			</Text>
			{standalone ? (
				<Text size="sm">
					当前路由显式声明了 <Code>frame: 'standalone'</Code>，因此不会挂宿主导航壳，但仍复用同一
					套鉴权、主题、RPC/SSE 客户端与运行时上下文。
				</Text>
			) : null}
			<Textarea
				label="任意输入（纯 UI 示例）"
				placeholder="这里不调用后端，仅展示 UI 能力…"
				minRows={4}
			/>
		</Stack>
	)
}

export function StandaloneRoutePage() {
	return <RoutePage frame="standalone" />
}
