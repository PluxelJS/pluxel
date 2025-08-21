import React, { memo, useMemo } from 'react'
import {
	Box,
	Card,
	CardSection,
	Text,
	Center,
	Group,
	Title,
	Badge,
	Divider,
	ScrollArea,
	Button,
} from '@mantine/core'
import { useQuery, keepPreviousData } from '@tanstack/react-query'
import { client, type InferSuccessResponse } from '../rpc'
import { ConfigForm } from './ConfigForm'
import { ActionBar } from './ActionBar'
import { LiveLog } from '../log_viewer/LiveLog'
import { DependencyList } from './DependencyList'
import { Link } from 'wouter'

interface PluginProps {
	pluginName: string
}

const $get = client.plugins[':name'].$get
type Response = InferSuccessResponse<typeof $get>
export type Dependencies = Response['dependencies']
type SafeDeps = NonNullable<Dependencies>
const EMPTY_DEPS = Object.freeze([]) as unknown as SafeDeps

const LEFT_WIDTH = 'clamp(320px, 34vw, 480px)'

/* ========== 左卡：日志区域撑满；横竖可滚；不裁宽 ========== */
const LeftPane = memo(function LeftPane(props: {
	name: string
	isRunning: boolean
	deps: SafeDeps
	desc: string
	syncing: boolean
}) {
	const { name, isRunning, deps, desc, syncing } = props
	return (
		<Card
			withBorder
			shadow="sm"
			style={{
				height: '100%',
				width: '100%',
				display: 'flex',
				flexDirection: 'column',
				minHeight: 0,
				minWidth: 0,
				overflow: 'hidden',
			}}
		>
			<CardSection withBorder px="md" py="sm">
				<Group
					justify="space-between"
					align="center"
					wrap="nowrap"
					style={{ minWidth: 0 }}
				>
					<Group
						gap="sm"
						align="center"
						wrap="nowrap"
						style={{ minWidth: 0, flex: 1 }}
					>
						<Title order={3} fw={600} lh={1.2} style={{ minWidth: 0 }}>
							<Box
								style={{
									overflow: 'hidden',
									textOverflow: 'ellipsis',
									whiteSpace: 'nowrap',
								}}
								title={name}
							>
								插件：{name}
							</Box>
						</Title>
						<Badge
							variant="light"
							color={isRunning ? 'green' : 'gray'}
							radius="sm"
						>
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
					<ActionBar
						pluginName={name}
						isSelfRunning={isRunning}
						dependencies={deps}
					/>
				</Group>
			</CardSection>

			<CardSection
				px="md"
				py="sm"
				style={{ flex: 1, minHeight: 0, display: 'flex' }}
			>
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

					{/* 长行也能看全：横竖都能滚 */}
					<Box
						style={{
							flex: 1,
							minHeight: 0,
							minWidth: 0,
							overflowX: 'auto',
							overflowY: 'auto',
						}}
					>
						<LiveLog module={name} />
					</Box>
				</Box>
			</CardSection>
		</Card>
	)
})

/* ========== 右卡：唯一 ScrollArea，负责竖向滚动 ========== */
const RightPane = memo(function RightPane(props: {
	name: string
	syncing: boolean
	config?: unknown
	existConfig?: unknown
}) {
	const { name, syncing, config, existConfig } = props
	return (
		<Card
			withBorder
			shadow="sm"
			style={{
				height: '100%',
				width: '100%',
				display: 'flex',
				flexDirection: 'column',
				minHeight: 0,
				minWidth: 0,
				overflow: 'hidden',
			}}
		>
			<CardSection withBorder px="md" py="sm">
				<Group
					justify="space-between"
					align="center"
					wrap="nowrap"
					style={{ minWidth: 0 }}
				>
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

			<CardSection
				px="md"
				py="sm"
				style={{ flex: 1, minHeight: 0, minWidth: 0, display: 'flex' }}
			>
				{/* 唯一滚动层：右卡自己滚 */}
				<ScrollArea type="auto" style={{ flex: 1, minHeight: 0, minWidth: 0 }}>
					{config ? (
						<ConfigForm
							pluginName={name}
							configs={config as any}
							existConfigs={existConfig as any}
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
			<Card
				withBorder
				shadow="sm"
				style={{ width: LEFT_WIDTH, minWidth: 0, height: '100%' }}
			/>
			<Card
				withBorder
				shadow="sm"
				style={{ flex: 1, minWidth: 0, height: '100%' }}
			/>
		</Box>
	)
}

export const Plugin = memo(function Plugin({ pluginName }: PluginProps) {
	// 1) 数据
	const q = useQuery({
		queryKey: ['plugin', pluginName] as const,
		enabled: !!pluginName,
		queryFn: async () => {
			const res = await $get({ param: { name: pluginName } })
			if (!res.ok) {
				const { error } = await res.json()
				throw new Error(error)
			}
			return res.json()
		},
		placeholderData: keepPreviousData,
		staleTime: 60_000,
		gcTime: 5 * 60_000,
		refetchOnMount: false,
		refetchOnWindowFocus: false,
		refetchOnReconnect: 'always',
		retry(failures, error) {
			if ((error as any)?.__notFound) return false
			return failures < 1
		},
	})

	const hasData = !!q.data
	const syncing = q.isFetching && hasData
	const name = q.data?.name ?? pluginName
	const isRunning = !!q.data?.isRunning
	const deps = useMemo<SafeDeps>(
		() => q.data?.dependencies ?? EMPTY_DEPS,
		[q.data?.dependencies],
	)
	const desc = q.data?.desc ?? ''
	const config = q.data?.config
	const existConfig = q.data?.existConfig

	if (!pluginName) {
		return (
			<Center h="100%">
				<Text c="dimmed" size="lg">
					请选择一个插件以查看详情
				</Text>
			</Center>
		)
	}

	if (q.isError) {
		return (
			<Center h="100%" style={{ gap: 12, flexDirection: 'column' }}>
				<Text c="red">{(q.error as Error).message || '加载失败，请重试'}</Text>
				<Button size="xs" onClick={() => q.refetch()}>
					重试
				</Button>
			</Center>
		)
	}

	if (q.isPending && !hasData) return <PluginSkeleton />

	// 2) 布局：一行两列，右侧独立滚动
	return (
		<Box
			h="100%"
			style={{
				display: 'flex',
				gap: 'var(--mantine-spacing-md)',
				minHeight: 0,
				minWidth: 0,
				overflow: 'hidden',
			}}
		>
			{/* 左列：固定宽度卡片 */}
			<Box
				style={{
					flex: '0 0 auto',
					width: LEFT_WIDTH,
					minWidth: 0,
					minHeight: 0,
					display: 'flex',
				}}
			>
				<LeftPane
					name={name}
					isRunning={isRunning}
					deps={deps}
					desc={desc}
					syncing={syncing}
				/>
			</Box>

			{/* 右列：占满剩余，内部 ScrollArea 独立滚 */}
			<Box
				style={{
					flex: 1,
					minWidth: 0,
					minHeight: 0,
					display: 'flex',
				}}
			>
				<RightPane
					name={name}
					syncing={syncing}
					config={config}
					existConfig={existConfig}
				/>
			</Box>
		</Box>
	)
})
