// src/plugins/Plugin.tsx
import React from 'react'
import {
	Box,
	Grid,
	Card,
	CardSection,
	Text,
	Center,
	Group,
	Title,
	Badge,
	Stack,
	Divider,
	LoadingOverlay,
	Skeleton,
	ScrollArea,
} from '@mantine/core'
import { useQuery } from '@tanstack/react-query'
import { client } from '../rpc'
import { ConfigForm } from './ConfigForm'
import { ActionBar } from './ActionBar'
import { LiveLog } from '../log_viewer/LiveLog'
import { DependencyList } from './DependencyList'
import { Link } from 'wouter'

interface PluginProps {
	pluginName: string
}

const $get = client.plugins[':name'].$get

export const Plugin: React.FC<PluginProps> = React.memo(
	({ pluginName }) => {
		const q = useQuery({
			queryKey: ['plugin', pluginName] as const,
			enabled: !!pluginName,
			queryFn: async () => {
				const res = await $get({ param: { name: pluginName } })
				if (!res.ok) throw new Error(`插件「${pluginName}」不存在`)
				return res.json()
			},
			staleTime: 60_000,
			refetchOnMount: false,
			refetchOnWindowFocus: false,
		})

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
				<Center h="100%">
					<Text c="red">{q.error.message || '加载失败，请重试'}</Text>
				</Center>
			)
		}

		return (
			<Box
				h="100%"
				style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}
			>
				<Grid
					gutter="md"
					align="stretch"
					style={{ height: '100%', minHeight: 0 }}
				>
					{/* 左列：信息 + 依赖 + 日志（日志吃满剩余） */}
					<Grid.Col
						span={{ base: 12, md: 5, lg: 4 }}
						style={{ display: 'flex', minHeight: 0 }} // 列可收缩
					>
						<Card
							withBorder
							shadow="sm"
							// 给日志保底空间但兼顾小屏
							mih="clamp(360px, 50vh, 720px)"
							style={{
								flex: 1,
								display: 'flex',
								flexDirection: 'column',
								minHeight: 0,
							}}
						>
							<CardSection withBorder px="md" py="sm">
								<Group justify="space-between" align="center">
									<Group gap="sm" align="center">
										<Title order={3} fw={600} lh={1.2}>
											插件：{q.data?.name ?? pluginName}
										</Title>
										<Badge
											variant="light"
											color={q.data?.isRunning ? 'green' : 'gray'}
											radius="sm"
										>
											{q.data?.isRunning ? '运行中' : '已停止'}
										</Badge>
									</Group>
									<ActionBar
										pluginName={q.data?.name ?? pluginName}
										isRunning={!!q.data?.isRunning}
										dependencies={q.data?.dependencies}
									/>
								</Group>
							</CardSection>

							<CardSection px="md" py="sm" style={{ flex: 1, minHeight: 0 }}>
								<Box
									style={{
										display: 'flex',
										flexDirection: 'column',
										height: '100%',
										gap: 'var(--mantine-spacing-sm)',
										minHeight: 0,
									}}
								>
									{/* 描述 */}
									{q.isPending ? (
										<Stack gap="xs">
											<Skeleton height={16} />
											<Skeleton height={16} width="80%" />
										</Stack>
									) : q.isSuccess && q.data.desc ? (
										<Text c="dimmed" size="sm">
											{q.data.desc}
										</Text>
									) : null}

									<Divider label="依赖" />

									{/* 依赖列表（自然高度） */}
									{q.isPending ? (
										<Stack gap="xs">
											<Skeleton height={12} />
											<Skeleton height={12} width="70%" />
										</Stack>
									) : (
										<DependencyList
											dependencies={q.data?.dependencies}
											LinkComponent={Link} // 若要求“锚点型 Link”，替换成 WouterLinkAdapter
										/>
									)}

									<Divider label="实时日志" />

									{/* 日志：吃满剩余，内部自己滚（若需要） */}
									<Box style={{ flex: 1, minHeight: 0 }}>
										<LiveLog module={q.data?.name ?? pluginName} />
									</Box>
								</Box>
							</CardSection>
						</Card>
					</Grid.Col>

					{/* 右列：配置（唯一滚动层，独立于左侧） */}
					<Grid.Col
						span={{ base: 12, md: 7, lg: 8 }}
						style={{ display: 'flex', minHeight: 0 }} // 列可收缩
					>
						<Card
							withBorder
							shadow="sm"
							style={{
								flex: 1,
								display: 'flex',
								flexDirection: 'column',
								minHeight: 0,
							}}
						>
							<CardSection withBorder px="md" py="sm">
								<Title order={4} fw={600}>
									配置
								</Title>
							</CardSection>

							{/* 唯一滚动层放这里，左右互不牵扯 */}
							<CardSection
								px="md"
								py="sm"
								style={{ flex: 1, minHeight: 0, display: 'flex' }}
							>
								<ScrollArea type="auto" style={{ flex: 1, minHeight: 0 }}>
									{q.isPending ? (
										<Stack gap="sm">
											<Skeleton height={18} />
											<Skeleton height={18} />
											<Skeleton height={18} width="70%" />
											<Skeleton height={140} />
										</Stack>
									) : q.isSuccess && q.data.config ? (
										<ConfigForm
											pluginName={q.data.name}
											configs={q.data.config}
											existConfigs={q.data.existConfig}
										/>
									) : (
										<Center mih={200}>
											<Text c="dimmed">该插件暂无可配置项</Text>
										</Center>
									)}
								</ScrollArea>
							</CardSection>
						</Card>
					</Grid.Col>
				</Grid>

				<LoadingOverlay visible={q.isPending} overlayProps={{ zIndex: 1000 }} />
			</Box>
		)
	},
	(prev, next) => prev.pluginName === next.pluginName,
)
