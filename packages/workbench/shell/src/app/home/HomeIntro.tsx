import {
	Alert,
	Badge,
	Button,
	Group,
	Loader,
	Paper,
	SimpleGrid,
	Skeleton,
	Text,
	Title,
	VisuallyHidden,
} from '@mantine/core'
import {
	IconAlertTriangle,
	IconArrowRight,
	IconCircleCheck,
	IconCloud,
	IconHistory,
	IconInfoCircle,
	IconPlugConnected,
	IconShieldCheck,
} from '@tabler/icons-react'
import type { ReactNode } from 'react'
import type { RuntimeMeta } from '@pluxel/services/management/client'
type PluxelPlatformSnapshot = RuntimeMeta['platform']
import { RouterLinkAdapter } from '../router/RouterLinkAdapter'
import { usePluginOverview, type PluginStatusEntry } from '../plugins/pluginOverview'
import { pluginAttention, type PluginAttention } from '../plugins/pluginOverviewModel'
import { useRuntimeMeta } from '../product'
import { useRuntimeUpdates } from '../runtimeUpdates'

type WorkspaceLink = {
	title: string
	description: string
	to: string
	icon: ReactNode
}

const WORKSPACE_LINKS: WorkspaceLink[] = [
	{
		title: '插件工作台',
		description: '查看运行状态、配置与依赖关系',
		to: '/plugins',
		icon: <IconPlugConnected size={20} stroke={1.7} />,
	},
	{
		title: '实时日志',
		description: '按级别筛选并追踪最新运行事件',
		to: '/logs',
		icon: <IconHistory size={20} stroke={1.7} />,
	},
	{
		title: '安全中心',
		description: '检查管理访问与近期安全事件',
		to: '/security',
		icon: <IconShieldCheck size={20} stroke={1.7} />,
	},
]

export function HomeIntro() {
	const overview = usePluginOverview()
	const runtimeMeta = useRuntimeMeta()
	const platform = runtimeMeta?.platform
	const summary = overview.overview?.status.summary
	const statuses = overview.overview?.status.statuses ?? []
	const runningPlugins = statuses.filter((plugin) => plugin.lifecycleState === 'running')
	const stoppedPlugins = statuses.filter((plugin) => plugin.lifecycleState === 'stopped')
	const attention = statuses.flatMap((plugin) => {
		const reason = pluginAttention(plugin)
		return reason ? [{ plugin, reason }] : []
	})
	const loading = !overview.hasSnapshot && overview.isLoading
	const metrics = [
		{ label: '插件总数', value: summary?.total },
		{ label: '正在运行', value: summary?.running, tone: 'running' },
		{
			label: '需要关注',
			value: overview.hasSnapshot ? attention.length : undefined,
			tone: attention.length > 0 ? 'attention' : undefined,
		},
		{ label: '自动启动', value: summary?.autoStart, tone: 'auto-start' },
	]

	return (
		<main className="plx-home">
			<section className="plx-home__hero" aria-labelledby="plx-home-title">
				<div className="plx-home__heroCopy">
					<Title id="plx-home-title" order={1} className="plx-home__title">
						运行工作台
					</Title>
					<PlatformSummary platform={platform} />
				</div>

				<div
					className="plx-home__runtimeSummary"
					aria-label="插件运行概览"
					aria-busy={loading || undefined}
				>
					{metrics.map((metric) => (
						<div className="plx-home__metric" data-tone={metric.tone} key={metric.label}>
							<Text className="plx-home__metricLabel">{metric.label}</Text>
							{loading ? (
								<Skeleton height={22} width={44} radius="sm" />
							) : (
								<Text
									className="plx-home__metricValue"
									title={typeof metric.value === 'number' ? undefined : '运行状态尚未读取'}
								>
									{typeof metric.value === 'number' ? metric.value : '—'}
								</Text>
							)}
						</div>
					))}
				</div>
			</section>

			<AttentionPanel
				items={attention}
				loading={loading}
				error={overview.error}
				hasSnapshot={overview.hasSnapshot}
				pluginCount={statuses.length}
				onRetry={() => void overview.refetch()}
			/>

			<section aria-label="常用工具">
				<SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="md">
					{WORKSPACE_LINKS.map((item) => (
						<WorkspaceCard key={item.to} {...item} />
					))}
				</SimpleGrid>
			</section>

			<section aria-labelledby="plx-home-queue-title">
				<div className="plx-home__sectionHeader">
					<Title id="plx-home-queue-title" order={2} className="plx-home__sectionTitle">
						插件
					</Title>
					<Text component={RouterLinkAdapter} to="/plugins" size="sm" className="plx-home__allLink">
						全部
					</Text>
				</div>

				<SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm" className="plx-home__pluginQueues">
					<PluginQueue
						title="运行中"
						plugins={runningPlugins}
						empty="无"
						loading={loading}
						error={overview.hasSnapshot ? undefined : overview.error}
					/>
					<PluginQueue
						title="未运行"
						plugins={stoppedPlugins}
						empty="无"
						loading={loading}
						error={overview.hasSnapshot ? undefined : overview.error}
					/>
				</SimpleGrid>
			</section>
		</main>
	)
}

export function platformNotice(platform: PluxelPlatformSnapshot | undefined): string | null {
	if (!platform) return null
	if (platform.runtime.name === 'workerd') {
		return '运行于 Cloudflare Workers，文件、长连接与持久化能力取决于部署适配器'
	}
	if (platform.runtime.name && platform.runtime.name !== 'node') {
		return `运行于 ${platform.runtime.name}，部分 Node 能力可能不可用`
	}
	if (platform.deployment.provider === 'cloudflare_workers') {
		return 'Cloudflare Workers 部署：请确认 WebSocket 与持久化绑定'
	}
	return null
}

function PlatformSummary({ platform }: { platform: PluxelPlatformSnapshot | undefined }) {
	if (!platform) return null
	const notice = platformNotice(platform)
	const runtimeLabel = [platform.runtime.name ?? 'unknown runtime', platform.runtime.version]
		.filter(Boolean)
		.join(' ')
	return (
		<div className="plx-home__platform">
			<Group gap={6} wrap="wrap" aria-label="宿主环境">
				<Badge variant="light" leftSection={<IconInfoCircle size={12} />}>
					{runtimeLabel}
				</Badge>
				{platform.platform ? <Badge variant="default">{platform.platform}</Badge> : null}
				{platform.deployment.provider ? (
					<Badge color="cyan" variant="light" leftSection={<IconCloud size={12} />}>
						{platform.deployment.provider.replaceAll('_', ' ')}
					</Badge>
				) : null}
				<Badge color={platform.mode === 'production' ? 'green' : 'gray'} variant="light">
					{platform.mode}
				</Badge>
				{platform.deployment.ci ? (
					<Badge color="violet" variant="light">
						CI
					</Badge>
				) : null}
			</Group>
			{notice ? (
				<Alert
					color="orange"
					icon={<IconInfoCircle size={16} />}
					className="plx-home__platformNotice"
				>
					{notice}
				</Alert>
			) : null}
		</div>
	)
}

function WorkspaceCard({ title, description, to, icon }: WorkspaceLink) {
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
				<Text className="plx-home__workspaceTitle">{title}</Text>
				<Text size="sm" c="dimmed">
					{description}
				</Text>
			</div>
		</Paper>
	)
}

type AttentionItem = Readonly<{ plugin: PluginStatusEntry; reason: PluginAttention }>

const UPDATE_PROBLEMS = {
	failed: '最近更新失败，应用已停止',
	'restored-previous': '最近更新失败，已恢复上一版本',
	'retained-previous': '最近更新未生效，仍运行上一版本',
	'applied-with-issues': '最近更新已应用，部分插件未启动',
} as const

/** Lists what needs action now; loading, read failure, no plugins and all-clear stay distinct. */
function AttentionPanel({
	items,
	loading,
	error,
	hasSnapshot,
	pluginCount,
	onRetry,
}: {
	items: readonly AttentionItem[]
	loading: boolean
	error?: string
	hasSnapshot: boolean
	pluginCount: number
	onRetry(): void
}) {
	const updates = useRuntimeUpdates()
	const update = updates.snapshot
	const updateProblem = update?.state === 'settled' && update.outcome !== 'applied' ? update : null
	const visible = items.slice(0, 8)
	const errors = items.filter((item) => item.reason.tone === 'error').length
	let body: ReactNode
	if (loading) {
		body = (
			<Group gap="xs" className="plx-home__attentionState" role="status">
				<Loader size={14} />
				<Text size="sm" c="dimmed">
					正在读取运行状态…
				</Text>
			</Group>
		)
	} else if (!hasSnapshot && error) {
		body = (
			<Alert color="red" icon={<IconAlertTriangle size={16} />} title="无法读取运行状态">
				<Group gap="sm" justify="space-between" wrap="nowrap">
					<Text size="sm">{error}</Text>
					<Button size="compact-sm" variant="light" color="red" onClick={onRetry}>
						重试
					</Button>
				</Group>
			</Alert>
		)
	} else if (pluginCount === 0) {
		body = (
			<Text size="sm" c="dimmed" className="plx-home__attentionState">
				尚未注册插件
			</Text>
		)
	} else if (visible.length === 0) {
		body = (
			<Group gap="xs" className="plx-home__attentionState" data-tone="ok">
				<IconCircleCheck size={16} aria-hidden />
				<Text size="sm">运行正常</Text>
			</Group>
		)
	} else {
		body = (
			<div className="plx-home__attentionList">
				{visible.map(({ plugin, reason }) => (
					<RouterLinkAdapter
						key={plugin.route}
						to={`/plugins/${plugin.route}`}
						className="plx-home__attentionRow"
						title={reason.message ?? undefined}
					>
						<span className="plx-home__statusDot" data-status={reason.tone} />
						<span className="plx-home__attentionName">{plugin.label}</span>
						<Badge size="sm" variant="light" color={reason.tone === 'error' ? 'red' : 'yellow'}>
							{reason.label}
						</Badge>
						<span className="plx-home__attentionMessage">{reason.message ?? '等待启动'}</span>
						<IconArrowRight size={15} aria-hidden="true" />
					</RouterLinkAdapter>
				))}
				{items.length > visible.length ? (
					<Text component={RouterLinkAdapter} to="/plugins" className="plx-home__attentionMore">
						还有 {items.length - visible.length} 个，查看全部
					</Text>
				) : null}
			</div>
		)
	}
	const title = (
		<Title id="plx-home-attention-title" order={2} className="plx-home__sectionTitle">
			需要关注
		</Title>
	)
	return (
		<section aria-labelledby="plx-home-attention-title">
			{items.length === 0 && !updateProblem ? (
				<VisuallyHidden>{title}</VisuallyHidden>
			) : (
				<div className="plx-home__sectionHeader">
					{title}
					{items.length > 0 ? (
						<Text size="sm" c="dimmed">
							{errors > 0 ? `${errors} 个异常` : null}
							{errors > 0 && items.length > errors ? ' · ' : null}
							{items.length > errors ? `${items.length - errors} 个等待启动` : null}
						</Text>
					) : null}
				</div>
			)}
			<div className="plx-home__attention">
				{updateProblem ? (
					<Alert
						color="yellow"
						icon={<IconAlertTriangle size={16} />}
						title={UPDATE_PROBLEMS[updateProblem.outcome]}
						className="plx-home__updateProblem"
					>
						{updateProblem.error ? (
							<Text size="xs" ff="monospace" className="plx-home__updateError">
								{updateProblem.error.file ? `${updateProblem.error.file}\n` : ''}
								{updateProblem.error.message}
							</Text>
						) : (
							<Text size="xs">详情见工具栏 HMR 状态</Text>
						)}
					</Alert>
				) : null}
				{body}
			</div>
		</section>
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
	const message = loading ? '正在读取运行状态…' : error ? '运行后端不可用' : empty

	return (
		<div className="plx-home__queue">
			<div className="plx-home__queueHeader">
				<Text fw={700}>{title}</Text>
				<Text size="xs" c="dimmed">
					{plugins.length}
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
									: plugin.lifecycleState !== 'running' && plugin.desiredState === 'running'
										? '等待运行'
										: null}
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
