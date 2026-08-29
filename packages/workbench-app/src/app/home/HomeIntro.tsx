import { Button, Group, Paper, SimpleGrid, Text, Title } from '@mantine/core'
import {
	IconArrowRight,
	IconHistory,
	IconPlugConnected,
	IconShieldCheck,
} from '@tabler/icons-react'
import type { ReactNode } from 'react'
import { RouterLinkAdapter } from '../RouterLinkAdapter'
import { usePluginOverview } from '../plugins/pluginOverview'

type WorkspaceLink = {
	title: string
	description: string
	to: string
	icon: ReactNode
	meta: string
}

const WORKSPACE_LINKS: WorkspaceLink[] = [
	{
		title: '插件工作台',
		description: '查看运行状态、配置与依赖关系',
		to: '/plugins',
		icon: <IconPlugConnected size={20} stroke={1.7} />,
		meta: '管理',
	},
	{
		title: '实时日志',
		description: '按级别筛选并追踪最新运行事件',
		to: '/logs',
		icon: <IconHistory size={20} stroke={1.7} />,
		meta: '诊断',
	},
	{
		title: '安全中心',
		description: '检查管理访问与近期安全事件',
		to: '/security',
		icon: <IconShieldCheck size={20} stroke={1.7} />,
		meta: '审计',
	},
]

export function HomeIntro() {
	const overview = usePluginOverview()
	const summary = overview.overview?.status.summary
	const statuses = overview.overview?.status.statuses ?? []
	const runningPlugins = statuses.filter((plugin) => plugin.lifecycleState === 'running')
	const stoppedPlugins = statuses.filter((plugin) => plugin.lifecycleState === 'stopped')
	const metrics = [
		{ label: '插件总数', value: summary?.total },
		{ label: '正在运行', value: summary?.running, tone: 'running' },
		{ label: '已停止', value: summary?.stopped },
		{ label: '自动启动', value: summary?.autoStart, tone: 'auto-start' },
	]

	return (
		<main className="plx-home">
			<section className="plx-home__hero" aria-labelledby="plx-home-title">
				<div className="plx-home__heroCopy">
					<Text className="plx-home__eyebrow">Runtime control center</Text>
					<Title id="plx-home-title" order={1} className="plx-home__title">
						运行工作台
					</Title>
					<Text className="plx-home__description">
						管理插件、依赖与运行日志，常用操作集中在当前页面。
					</Text>
					<Group gap="sm" className="plx-home__heroActions">
						<Button
							component={RouterLinkAdapter}
							to="/plugins"
							leftSection={<IconPlugConnected size={17} />}
						>
							打开插件工作台
						</Button>
						<Button component={RouterLinkAdapter} to="/logs" variant="default">
							查看实时日志
						</Button>
					</Group>
				</div>

				<div className="plx-home__runtimeSummary" aria-label="插件运行概览">
					{metrics.map((metric) => (
						<div className="plx-home__metric" data-tone={metric.tone} key={metric.label}>
							<Text className="plx-home__metricLabel">{metric.label}</Text>
							<Text className="plx-home__metricValue">
								{typeof metric.value === 'number' ? metric.value : '—'}
							</Text>
						</div>
					))}
				</div>
			</section>

			<section aria-labelledby="plx-home-tools-title">
				<div className="plx-home__sectionHeader">
					<div>
						<Text className="plx-home__sectionKicker">工作区</Text>
						<Title id="plx-home-tools-title" order={2} className="plx-home__sectionTitle">
							常用工具
						</Title>
					</div>
					<Text size="sm" c="dimmed">
						{WORKSPACE_LINKS.length} 个核心入口
					</Text>
				</div>

				<SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }} spacing="sm">
					{WORKSPACE_LINKS.map((item) => (
						<WorkspaceCard key={item.to} {...item} />
					))}
				</SimpleGrid>
			</section>

			<section aria-labelledby="plx-home-queue-title">
				<div className="plx-home__sectionHeader">
					<div>
						<Text className="plx-home__sectionKicker">实时状态</Text>
						<Title id="plx-home-queue-title" order={2} className="plx-home__sectionTitle">
							插件运行队列
						</Title>
					</div>
					<Text component={RouterLinkAdapter} to="/plugins" size="sm" className="plx-home__allLink">
						查看全部插件
					</Text>
				</div>

				<SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm" className="plx-home__pluginQueues">
					<PluginQueue
						title="正在运行"
						plugins={runningPlugins}
						empty="当前没有正在运行的插件"
						loading={!overview.hasSnapshot && overview.isLoading}
						error={overview.error}
					/>
					<PluginQueue
						title="当前未运行"
						plugins={stoppedPlugins}
						empty="当前没有已停止的插件"
						loading={!overview.hasSnapshot && overview.isLoading}
						error={overview.error}
					/>
				</SimpleGrid>
			</section>
		</main>
	)
}

function WorkspaceCard({ title, description, to, icon, meta }: WorkspaceLink) {
	return (
		<Paper
			component={RouterLinkAdapter as any}
			to={to}
			className="plx-home__workspaceCard"
			withBorder
			radius="md"
			p="md"
		>
			<div className="plx-home__workspaceIcon">{icon}</div>
			<div className="plx-home__workspaceCopy">
				<div className="plx-home__workspaceTitleLine">
					<Text className="plx-home__workspaceTitle">{title}</Text>
					<Text className="plx-home__workspaceMeta">{meta}</Text>
				</div>
				<Text size="sm" c="dimmed">
					{description}
				</Text>
			</div>
		</Paper>
	)
}

function PluginQueue({
	empty,
	error,
	loading,
	plugins,
	title,
}: {
	empty: string
	error?: string
	loading: boolean
	plugins: Array<{
		route: string
		label: string
		availability: 'available' | 'unavailable'
		desiredState: 'running' | 'stopped'
		lifecycleState: 'running' | 'stopped'
	}>
	title: string
}) {
	const visiblePlugins = plugins.slice(0, 6)
	const message = loading ? '正在读取运行状态…' : error ? '运行后端暂时不可用' : empty

	return (
		<div className="plx-home__queue">
			<div className="plx-home__queueHeader">
				<Text fw={700}>{title}</Text>
				<Text size="xs" c="dimmed">
					{plugins.length} 个
				</Text>
			</div>
			<div className="plx-home__queueBody">
				{visiblePlugins.length > 0 ? (
					visiblePlugins.map((plugin) => (
						<RouterLinkAdapter
							key={plugin.route}
							to={`/plugins/${plugin.route}`}
							className="plx-home__queueRow"
						>
							<span
								className="plx-home__statusDot"
								data-status={
									plugin.availability === 'unavailable'
										? 'unavailable'
										: plugin.lifecycleState === 'running'
											? 'running'
											: plugin.desiredState === 'running'
												? 'pending'
												: 'stopped'
								}
							/>
							<span className="plx-home__queueName">{plugin.label}</span>
							<span className="plx-home__queueStatus">
								{plugin.availability === 'unavailable'
									? '不可用'
									: plugin.lifecycleState === 'running'
										? '运行中'
										: plugin.desiredState === 'running'
											? '等待运行'
											: '已停止'}
							</span>
							<IconArrowRight size={15} aria-hidden="true" />
						</RouterLinkAdapter>
					))
				) : (
					<Text className="plx-home__queueEmpty">{message}</Text>
				)}
			</div>
		</div>
	)
}
