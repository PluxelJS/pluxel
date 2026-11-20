import {
	Alert,
	Badge,
	Button,
	Group,
	Loader,
	Skeleton,
	Text,
	Title,
	VisuallyHidden,
} from '@mantine/core'
import {
	IconAlertTriangle,
	IconArrowRight,
	IconCircleCheck,
	IconInfoCircle,
} from '@tabler/icons-react'
import type { ReactNode } from 'react'
import type { RuntimeMeta } from '@pluxel/services/management/client'
type PluxelPlatformSnapshot = RuntimeMeta['platform']
import { RouterLinkAdapter } from '../router/RouterLinkAdapter'
import { usePluginOverview, type PluginStatusEntry } from '../plugins/pluginOverview'
import { pluginAttention, type PluginAttention } from '../plugins/pluginOverviewModel'
import { useRuntimeMeta } from '../product'
import { useRuntimeUpdates } from '../runtimeUpdates'
import { HomeApps } from './HomeApps'
import { HomeLogs } from './HomeLogs'

export function HomeIntro() {
	const overview = usePluginOverview()
	const runtimeMeta = useRuntimeMeta()
	const platform = runtimeMeta?.platform
	const summary = overview.overview?.status.summary
	const statuses = overview.overview?.status.statuses ?? []
	// Plugins that are not simply running come first, so the list doubles as a to-do list.
	const sortedPlugins = [...statuses].sort(
		(left, right) =>
			Number(isRunning(left)) - Number(isRunning(right)) || left.label.localeCompare(right.label),
	)
	const attention = statuses.flatMap((plugin) => {
		const reason = pluginAttention(plugin)
		return reason ? [{ plugin, reason }] : []
	})
	const loading = !overview.hasSnapshot && overview.isLoading
	const metrics = [
		{ label: '插件', value: summary?.total },
		{ label: '运行中', value: summary?.running, tone: 'running' },
		{
			label: '需关注',
			value: overview.hasSnapshot ? attention.length : undefined,
			tone: attention.length > 0 ? 'attention' : undefined,
		},
		{ label: '自动启动', value: summary?.autoStart, tone: 'auto-start' },
	]

	return (
		<main className="plx-home">
			<header className="plx-home__header">
				<div className="plx-home__heading">
					<Title id="plx-home-title" order={1} className="plx-home__title">
						概览
					</Title>
					<PlatformSummary platform={platform} />
				</div>
				<dl
					className="plx-home__metrics"
					aria-label="插件运行概览"
					aria-busy={loading || undefined}
				>
					{metrics.map((metric) => (
						<div className="plx-home__metric" data-tone={metric.tone} key={metric.label}>
							<dd className="plx-home__metricValue">
								{loading ? (
									<Skeleton height={20} width={28} radius="sm" />
								) : typeof metric.value === 'number' ? (
									metric.value
								) : (
									<span title="运行状态尚未读取">—</span>
								)}
							</dd>
							<dt className="plx-home__metricLabel">{metric.label}</dt>
						</div>
					))}
				</dl>
			</header>

			<AttentionPanel
				items={attention}
				loading={loading}
				error={overview.error}
				hasSnapshot={overview.hasSnapshot}
				pluginCount={statuses.length}
				onRetry={() => void overview.refetch()}
			/>

			<div className="plx-home__columns">
				<section aria-labelledby="plx-home-queue-title" className="plx-home__plugins">
					<div className="plx-home__sectionHeader">
						<Title id="plx-home-queue-title" order={2} className="plx-home__sectionTitle">
							插件
						</Title>
						<Text
							component={RouterLinkAdapter}
							to="/plugins"
							size="xs"
							className="plx-home__allLink"
						>
							管理
						</Text>
					</div>
					{sortedPlugins.length > 0 ? <PluginQueue plugins={sortedPlugins} /> : null}
				</section>
				<div className="plx-home__side">
					<HomeApps />
					<HomeLogs />
				</div>
			</div>
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
	const facts = [
		[platform.runtime.name ?? 'unknown runtime', platform.runtime.version]
			.filter(Boolean)
			.join(' '),
		platform.platform,
		platform.deployment.provider?.replaceAll('_', ' '),
		platform.mode,
		platform.deployment.ci ? 'CI' : undefined,
	].filter(Boolean)
	return (
		<>
			<Text component="p" size="xs" c="dimmed" className="plx-home__platform" aria-label="宿主环境">
				{facts.join(' · ')}
			</Text>
			{notice ? (
				<Alert
					color="orange"
					icon={<IconInfoCircle size={16} />}
					className="plx-home__platformNotice"
				>
					{notice}
				</Alert>
			) : null}
		</>
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
	plugins,
}: {
	plugins: Array<{
		route: string
		label: string
		availability: 'available' | 'unavailable'
		desiredState: 'running' | 'stopped'
		lifecycleState: 'running' | 'stopped'
	}>
}) {
	return (
		<div className="plx-home__queue">
			{plugins.map((plugin) => (
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
								? null
								: plugin.desiredState === 'running'
									? '等待运行'
									: '已停止'}
					</span>
					<IconArrowRight size={14} aria-hidden="true" />
				</RouterLinkAdapter>
			))}
		</div>
	)
}

function isRunning(plugin: { availability: string; lifecycleState: string }): boolean {
	return plugin.availability !== 'unavailable' && plugin.lifecycleState === 'running'
}
