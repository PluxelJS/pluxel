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
import React, { memo, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'wouter'
import { LiveLog as LiveLogRaw } from '../log_viewer/LiveLog'
import { client, type InferSuccessResponse } from '../rpc'
import { ActionBar } from './ActionBar'
import { ConfigForm } from './ConfigForm'
import { DependencyList } from './DependencyList'

const $get = client.plugins[':name'].$get
type Response = InferSuccessResponse<typeof $get>
export type Dependencies = Response['dependencies']
type SafeDeps = NonNullable<Dependencies>
const EMPTY_DEPS = Object.freeze([]) as unknown as SafeDeps

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

/* ---------- 小工具：去抖布尔 ---------- */
function useDebouncedFlag(value: boolean, delay = 200) {
	const [v, setV] = useState(value)
	useEffect(() => {
		if (value) {
			const t = setTimeout(() => setV(true), delay)
			return () => clearTimeout(t)
		}
		// 关闭时立即关（不积累延迟），减少“冒泡”时间
		setV(false)
	}, [value, delay])
	return v
}

/* ========== 左卡 ========== */
const LeftPane = memo(function LeftPane(props: {
	pluginName: string
	deps: SafeDeps
	desc: string
	syncing: boolean
}) {
	const { pluginName, deps, desc, syncing } = props

	const $getStatus = client.plugins[':name'].status.$get
	const q = useQuery({
		queryKey: ['plugin', pluginName, 'status'] as const,
		enabled: !!pluginName,
		queryFn: async () => {
			const res = await $getStatus({ param: { name: pluginName } })
			if (!res.ok) throw new Error('获取插件状态出错')
			return res.json()
		},
		placeholderData: keepPreviousData,
		staleTime: 60_000,
	})

	const isRunning = q.data?.isRunning ?? false
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
								title={pluginName}
							>
								插件：{pluginName}
							</Box>
						</Title>
						<Badge variant="light" color={isRunning ? 'green' : 'gray'} radius="sm">
							{isRunning ? '运行中' : '已停止'}
						</Badge>
						<Badge
							variant="dot"
							color="blue"
							radius="sm"
							style={{ visibility: syncing ? 'visible' : 'hidden' }}
						>
							同步中…
						</Badge>
					</Group>
					<ActionBar pluginName={pluginName} isSelfRunning={isRunning} dependencies={deps} />
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
						{deps.length ? (
							<DependencyList dependencies={deps} LinkComponent={Link} />
						) : (
							<Text c="dimmed" size="sm">
								无依赖
							</Text>
						)}
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
						<LiveLog module={pluginName} />
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
					<Badge
						variant="dot"
						color="blue"
						radius="sm"
						style={{ visibility: syncing ? 'visible' : 'hidden' }}
					>
						同步中…
					</Badge>
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
	// 主信息查询：用 select 归一化字段与引用
	const q = useQuery({
		queryKey: ['plugin', pluginName] as const,
		enabled: !!pluginName,
		queryFn: async () => {
			const res = await $get({ param: { name: pluginName } })
			if (!res.ok) {
				const { error } = await res.json()
				// 将“未找到”类错误提升到 message
				throw new Error(error || '加载失败')
			}
			return res.json() as Promise<Response>
		},
		placeholderData: keepPreviousData,
		staleTime: 60_000,
		gcTime: 5 * 60_000,
		refetchOnMount: false,
		refetchOnWindowFocus: false,
		refetchOnReconnect: 'always',
		// —— 关键：select 里稳定空集合，减少子树无谓重渲染 —— //
		select: (
			r,
		): {
			name: string
			deps: SafeDeps
			desc: string
		} => ({
			name: r?.name ?? pluginName,
			deps: r?.dependencies?.length ? (r.dependencies as SafeDeps) : EMPTY_DEPS,
			desc: r?.desc ?? '',
		}),
	})

	// 去抖同步状态，避免闪烁引发的重渲染
	const syncing = useDebouncedFlag(q.isFetching, 160)

	if (!pluginName) {
		return (
			<Center h="100%">
				<Text c="dimmed" size="lg">
					请选择一个插件以查看详情
				</Text>
			</Center>
		)
	}

	if (q.isError && !q.data) {
		return (
			<Center h="100%" style={{ gap: 12, flexDirection: 'column' }}>
				<Text c="red">{(q.error as Error).message || '加载失败，请重试'}</Text>
				<Button size="xs" onClick={() => q.refetch()}>
					重试
				</Button>
			</Center>
		)
	}

	if (q.isPending && !q.data) return <PluginSkeleton />

	const { name, deps, desc } = q.data!

	return (
		<Box h="100%" style={{ ...ROW_WRAP }}>
			{/* 左列：固定宽度 */}
			<Box style={{ ...FLEX_0_LEFT }}>
				<LeftPane pluginName={name} deps={deps} desc={desc} syncing={syncing} />
			</Box>

			{/* 右列：占满剩余，内部独立滚动 */}
			<Box style={{ ...FLEX_1 }}>
				<RightPane pluginName={name} syncing={syncing} />
			</Box>
		</Box>
	)
})
