import {
	Badge,
	Box,
	Button,
	Card,
	CardSection,
	Center,
	Divider,
	Group,
	ScrollArea,
	Text,
	Title,
} from '@mantine/core'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import React, { memo, useCallback } from 'react'
import { Link } from 'wouter'
import { LiveLog as LiveLogRaw } from '../log_viewer/LiveLog'
import { client } from '../rpc'
import { useQuery as useGqtyQuery, useRefetch } from '../gqty'
import type { PluginScope } from '../gqty'
import { ActionBar } from './ActionBar'
import { ConfigForm } from './ConfigForm'
import { DependencyList } from './DependencyList'

/* ---------- 常量 ---------- */

const LEFT_WIDTH = 'clamp(320px, 34vw, 480px)'
const CARD_FLEX_COL = {
	height: '100%',
	width: '100%',
	display: 'flex',
	flexDirection: 'column' as const,
	minHeight: 0,
	minWidth: 0,
	overflow: 'hidden',
}
const ROW_WRAP = {
	display: 'flex',
	gap: 'var(--mantine-spacing-md)',
	minHeight: 0,
	minWidth: 0,
	overflow: 'hidden',
}
const FLEX_1 = { flex: 1, minHeight: 0, minWidth: 0, display: 'flex' }
const FLEX_0_LEFT = {
	flex: '0 0 auto',
	width: LEFT_WIDTH,
	minWidth: 0,
	minHeight: 0,
	display: 'flex',
}

// 在使用点包一层，确保 memo
const LiveLog = memo(LiveLogRaw)

/* ========== 左卡 ========== */
const LeftPane = memo(function LeftPane(props: {
	scope: PluginScope | undefined
	fallbackName: string
	isSyncing: boolean
	onStatusUpdated: () => Promise<void> | void
}) {
	const { scope, fallbackName, isSyncing, onStatusUpdated } = props
	const displayName = scope?.name ?? fallbackName
	const detail = scope?.detail
	const desc = detail?.desc ?? ''
	const isRunning = Boolean(scope?.status?.isRunning)

	return (
		<Card withBorder shadow="sm" style={CARD_FLEX_COL}>
			<CardSection withBorder px="md" py="sm">
				<Group justify="space-between" align="center" wrap="nowrap" style={{ minWidth: 0 }}>
					<Group gap="sm" align="center" wrap="nowrap" style={{ minWidth: 0, flex: 1 }}>
						<Title order={3} fw={600} lh={1.2} style={{ minWidth: 0 }}>
							<Box
								style={{
									overflow: 'hidden',
									textOverflow: 'ellipsis',
									whiteSpace: 'nowrap',
								}}
									title={displayName}
							>
									插件：{displayName}
							</Box>
						</Title>
						<Badge variant="light" color={isRunning ? 'green' : 'gray'} radius="sm">
							{isRunning ? '运行中' : '已停止'}
						</Badge>
						{isSyncing && (
							<Badge variant="dot" color="blue" radius="sm">
								同步中…
							</Badge>
						)}
					</Group>
					<ActionBar
						scope={scope}
						fallbackName={displayName}
						onStatusUpdated={onStatusUpdated}
					/>
				</Group>
			</CardSection>

			<CardSection px="md" py="sm" style={{ ...FLEX_1 }}>
				<Box
					style={{
						display: 'flex',
						flexDirection: 'column',
						gap: 'var(--mantine-spacing-sm)',
						flex: 1,
						minHeight: 0,
						minWidth: 0,
					}}
				>
					{desc ? (
						<Text c="dimmed" size="sm" lh={1.4}>
							{desc}
						</Text>
					) : (
						<Text size="sm" style={{ opacity: 0 }}>
							.
						</Text>
					)}

					<Divider label="依赖" />
					<Box style={{ flexShrink: 0 }}>
						<DependencyList scope={scope} LinkComponent={Link} />
					</Box>

					<Divider label="实时日志" />

					{/* 横竖可滚以显示长行 */}
					<Box
						style={{
							flex: 1,
							minHeight: 0,
							minWidth: 0,
							overflowX: 'auto',
							overflowY: 'auto',
						}}
					>
						{/* LiveLog 的 props 保持稳定：仅 module=name */}
							<LiveLog module={displayName} />
					</Box>
				</Box>
			</CardSection>
		</Card>
	)
})

/* ========== 右卡 ========== */
const RightPane = memo(function RightPane(props: { pluginName: string; syncing: boolean }) {
	const { pluginName, syncing } = props
	const $getConfig = client.plugins[':name'].config.$get

	const q = useQuery({
		queryKey: ['plugin', pluginName, 'config'] as const,
		enabled: !!pluginName,
		queryFn: async () => {
			const res = await $getConfig({ param: { name: pluginName } })
			if (!res.ok) throw new Error('获取插件配置出错')
			return res.json()
		},
		// 保持旧数据不抖动
		placeholderData: keepPreviousData,
		staleTime: 60_000,
		// 只抽我们要的，避免下游反复解构
		select: (data: any) =>
			({
				config: data?.config ?? null,
				existConfig: data?.existConfig ?? null,
			}) as { config: unknown | null; existConfig: unknown | null },
		// 避免窗口聚焦/重新连接时频繁抖动右侧表单（按需打开）
		refetchOnWindowFocus: false,
		refetchOnReconnect: 'always',
		refetchOnMount: false,
	})

	return (
		<Card withBorder shadow="sm" style={CARD_FLEX_COL}>
			<CardSection withBorder px="md" py="sm">
				<Group justify="space-between" align="center" wrap="nowrap" style={{ minWidth: 0 }}>
					<Title order={4} fw={600}>
						配置
					</Title>
					{syncing && (
						<Badge variant="dot" color="blue" radius="sm">
							同步中…
						</Badge>
					)}
				</Group>
			</CardSection>

			<CardSection px="md" py="sm" style={{ ...FLEX_1 }}>
				<ScrollArea type="auto" style={{ flex: 1, minHeight: 0, minWidth: 0 }}>
					{q.data?.config ? (
						<ConfigForm
							pluginName={pluginName}
							configs={q.data.config as any}
							existConfigs={q.data.existConfig as any}
						/>
					) : (
						<Center mih={200}>
							<Text c="dimmed">该插件暂无可配置项</Text>
						</Center>
					)}
				</ScrollArea>
			</CardSection>
		</Card>
	)
})

/* ========== 骨架屏 ========== */
function PluginSkeleton() {
	return (
		<Box
			style={{
				display: 'flex',
				gap: 'var(--mantine-spacing-md)',
				height: '100%',
				minHeight: 0,
				minWidth: 0,
			}}
		>
			<Card withBorder shadow="sm" style={{ width: LEFT_WIDTH, minWidth: 0, height: '100%' }} />
			<Card withBorder shadow="sm" style={{ flex: 1, minWidth: 0, height: '100%' }} />
		</Box>
	)
}

/* ========== 主组件 ========== */
export const Plugin = memo(function Plugin({ pluginName }: { pluginName: string }) {
	const query = useGqtyQuery({ suspense: false })
	const refetch = useRefetch()

	const scope = pluginName ? query.plugin({ name: pluginName }) : undefined
	const detail = scope?.detail
	const status = scope?.status

	const displayName = scope?.name ?? pluginName
	const isSyncing = query.$state.isLoading

	const refetchPlugin = useCallback(() => {
		if (!pluginName) return Promise.resolve(undefined)
		return refetch((root) => {
			const next = root.plugin({ name: pluginName })
			next.status.isRunning
			next.detail.desc
			next.detail.dependencies?.map((dep) => {
				dep?.name
				dep?.isRunning
				dep?.optional
				return null
			})
			return next.status.isRunning
		})
	}, [pluginName, refetch])

	const refetchPluginStatus = useCallback(
		() =>
			refetch((root) => {
				const overview = root.pluginStatus
				overview.summary.total
				overview.summary.running
				overview.statuses?.map((item) => {
					item?.name
					item?.isRunning
					return null
				})
				return overview.summary.total
			}),
		[refetch],
	)

	const handleStatusUpdated = useCallback(
		async () => {
			await Promise.all([refetchPlugin(), refetchPluginStatus()])
		},
		[refetchPlugin, refetchPluginStatus],
	)

	const hasData = Boolean(detail && status)
	const error = query.$state.error

	if (!pluginName) {
		return (
			<Center h="100%">
				<Text c="dimmed" size="lg">
					请选择一个插件以查看详情
				</Text>
			</Center>
		)
	}

	if (error && !hasData) {
		return (
			<Center h="100%" style={{ gap: 12, flexDirection: 'column' }}>
				<Text c="red">{error.message || '加载失败，请重试'}</Text>
				<Button size="xs" onClick={() => void refetchPlugin()}>
					重试
				</Button>
			</Center>
		)
	}

	if (!hasData) return <PluginSkeleton />

	return (
		<Box h="100%" style={{ ...ROW_WRAP }}>
			{/* 左列：固定宽度 */}
			<Box style={{ ...FLEX_0_LEFT }}>
				<LeftPane
					scope={scope as PluginScope | undefined}
					fallbackName={displayName}
					isSyncing={isSyncing}
					onStatusUpdated={handleStatusUpdated}
				/>
			</Box>

			{/* 右列：占满剩余，内部独立滚动 */}
			<Box style={{ ...FLEX_1 }}>
				<RightPane pluginName={displayName} syncing={isSyncing} />
			</Box>
		</Box>
	)
})
