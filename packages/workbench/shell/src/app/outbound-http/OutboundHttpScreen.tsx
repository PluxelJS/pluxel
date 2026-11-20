import { Alert, Anchor, Button, Group, Loader, Stack, Table, Text, Title } from '@mantine/core'
import { formatPluginNodeReference, pluginNodeIndexKey, type PluginNodeAddress } from '@pluxel/core'
import { OUTBOUND_HTTP_LOG_STREAM_ID } from '@pluxel/core/logging/protocol'
import type { OutboundHttpActivity } from '@pluxel/services/management/protocol'
import { useQuery } from '@tanstack/react-query'
import { memo, useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { ErrorState } from '../../components'
import { runtimeErrorMessage, useRuntimeManagementClient } from '../../runtime'
import { LogRow } from '../log_viewer/LogRow'
import { useLogStream } from '../log_viewer/useLogStream'
import { managementQueryKeys } from '../managementQuery'
import { usePluginOverview } from '../plugins/pluginOverview'
import { RouterLinkAdapter } from '../router/RouterLinkAdapter'
import {
	buildOutboundHttpActivityHref,
	buildOutboundHttpLogsHref,
	buildOutboundHttpNodeHref,
	OUTBOUND_HTTP_DEFAULTS_PATH,
	OUTBOUND_HTTP_PATH,
} from './paths'

const dateTime = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'medium' })
const wrapText = { overflowWrap: 'anywhere' } as const
const activityOutcome = { response: '收到响应', failed: '传输失败', denied: '策略拒绝' } as const

export function OutboundHttpScreen({ owner }: { owner?: PluginNodeAddress }) {
	const management = useRuntimeManagementClient()
	const { overview } = usePluginOverview()
	const labels = useMemo(() => {
		const nodes = (overview?.status.statuses ?? []).map(({ address, label }) => ({
			address,
			label: address.variant === 'fork' ? `${label} · ${address.forkId}` : label,
		}))
		const seen = new Set<string>()
		const repeated = new Set<string>()
		for (const { label } of nodes) {
			if (seen.has(label)) repeated.add(label)
			seen.add(label)
		}
		return new Map(
			nodes.map(({ address, label }) => [
				pluginNodeIndexKey(address),
				repeated.has(label) ? `${label} · ${formatPluginNodeReference(address)}` : label,
			]),
		)
	}, [overview])
	const query = useQuery({
		queryKey: managementQueryKeys.outboundHttpScope(null),
		queryFn: () => management.outboundHttp.get(null),
	})
	const snapshot = query.data
	const records = snapshot?.managed ? snapshot.records : undefined
	const hasRequestLogs = records === 'requests'
	const logs = useLogStream({
		streamId: OUTBOUND_HTTP_LOG_STREAM_ID,
		filter: { plugin: owner },
		capacity: 12,
		historyLimit: 12,
		enabled: hasRequestLogs,
	})
	const version = useSyncExternalStore(
		logs.store.subscribe,
		logs.store.getVersion,
		logs.store.getVersion,
	)
	const refreshTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
	const { refetch } = query
	useEffect(() => {
		if (!hasRequestLogs || !logs.meta || refreshTimer.current !== undefined) return
		// Reconcile the Host's roster after stream resets and batches of request records.
		refreshTimer.current = setTimeout(() => {
			refreshTimer.current = undefined
			void refetch()
		}, 500)
	}, [hasRequestLogs, version, logs.meta, refetch])
	useEffect(
		() => () => {
			clearTimeout(refreshTimer.current)
			refreshTimer.current = undefined
		},
		[hasRequestLogs],
	)
	const ownerKey = owner ? pluginNodeIndexKey(owner) : undefined
	const activity = useMemo(() => {
		const items = snapshot?.managed ? snapshot.activity : []
		return ownerKey ? items.filter((item) => pluginNodeIndexKey(item.owner) === ownerKey) : items
	}, [snapshot, ownerKey])

	return (
		<Stack h="100%" gap="md" p="var(--plx-page-padding)" style={{ minWidth: 0, overflow: 'auto' }}>
			<Group justify="space-between" gap="xs">
				<Title order={1} size="h3">
					{snapshot?.managed === false ? '出站 HTTP' : '受管出站 HTTP'}
				</Title>
				<Group gap="xs">
					{hasRequestLogs && (
						<Button
							component={RouterLinkAdapter}
							to={buildOutboundHttpLogsHref(owner)}
							size="compact-sm"
							variant="default"
						>
							完整联网日志
						</Button>
					)}
					{snapshot?.managed && (
						<Button
							component={RouterLinkAdapter}
							to={OUTBOUND_HTTP_DEFAULTS_PATH}
							size="compact-sm"
							variant="default"
						>
							宿主默认设置
						</Button>
					)}
					<Button
						size="compact-sm"
						variant="subtle"
						loading={query.isFetching}
						onClick={() => {
							void refetch()
							if (hasRequestLogs && logs.error) logs.retry()
						}}
					>
						刷新
					</Button>
				</Group>
			</Group>
			{owner && (
				<Group gap="xs">
					<Text size="sm" fw={600} style={wrapText}>
						{(ownerKey && labels.get(ownerKey)) ?? formatPluginNodeReference(owner)}
					</Text>
					{snapshot?.managed && (
						<Anchor component={RouterLinkAdapter} to={buildOutboundHttpNodeHref(owner)} size="xs">
							出站设置
						</Anchor>
					)}
					<Anchor component={RouterLinkAdapter} to={OUTBOUND_HTTP_PATH} size="xs">
						全部节点
					</Anchor>
				</Group>
			)}
			{snapshot ? (
				<>
					{query.isRefetchError && (
						<Alert color="red" title="刷新出站活动失败">
							{runtimeErrorMessage(query.error)}
						</Alert>
					)}
					{snapshot.managed === false ? (
						<Text size="sm" c="dimmed">
							宿主使用平台 Fetch 或部署声明的传输，保留插件生命周期取消。
						</Text>
					) : records === 'off' ? (
						<Text size="sm" c="dimmed">
							宿主已关闭联网记录。
						</Text>
					) : (
						<OutboundActivity
							activity={activity}
							labels={labels}
							filtered={owner !== undefined}
							hasRequestLogs={hasRequestLogs}
						/>
					)}
				</>
			) : query.isPending ? (
				<Group role="status">
					<Loader size="sm" />
					<Text size="sm" c="dimmed">
						正在读取出站活动…
					</Text>
				</Group>
			) : (
				<ErrorState
					title="出站活动不可用"
					message={runtimeErrorMessage(query.error)}
					onRetry={() => void refetch()}
				/>
			)}
			{hasRequestLogs && (
				<Stack gap="xs" component="section" aria-label="最近联网记录">
					<Group gap="xs">
						<Title order={2} size="h5">
							最近联网记录
						</Title>
						{logs.status === 'live' && (
							<Text size="xs" c="dimmed">
								实时更新
							</Text>
						)}
					</Group>
					{logs.error ? (
						<ErrorState title="联网日志读取失败" message={logs.error} onRetry={logs.retry} />
					) : logs.store.length === 0 ? (
						<Text size="sm" c="dimmed" role="status">
							{logs.status === 'loading' ? '正在读取联网日志…' : '暂无联网记录'}
						</Text>
					) : (
						<ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
							{logs.store
								.toArray()
								.toReversed()
								.map((line, index) => (
									<li key={`${line.epoch}:${line.seq}`}>
										<LogRow
											line={line}
											preview
											showName={!owner}
											striped={index % 2 === 1}
											ansi={false}
										/>
									</li>
								))}
						</ol>
					)}
				</Stack>
			)}
		</Stack>
	)
}

const OutboundActivity = memo(function OutboundActivity({
	activity,
	labels,
	filtered,
	hasRequestLogs,
}: {
	activity: readonly OutboundHttpActivity[]
	labels: ReadonlyMap<string, string>
	filtered: boolean
	hasRequestLogs: boolean
}) {
	const items = [...activity].sort((a, b) => b.lastAttemptAt - a.lastAttemptAt)
	return (
		<Stack gap="xs" component="section" aria-label="联网节点">
			<Group gap="xs" align="baseline">
				<Title order={2} size="h5">
					联网节点
				</Title>
				<Text size="xs" c="dimmed">
					{items.length} 个
				</Text>
			</Group>
			{items.length === 0 ? (
				<Text size="sm" c="dimmed">
					{filtered
						? '本次宿主运行尚未记录到此节点的受管请求。'
						: '等待本次运行中经 ctx.wretch 或 ctx.fetch 发出的请求。'}
				</Text>
			) : (
				<Table.ScrollContainer minWidth={640}>
					<Table verticalSpacing="xs">
						<Table.Thead>
							<Table.Tr>
								<Table.Th>插件节点</Table.Th>
								<Table.Th>最近请求</Table.Th>
								<Table.Th>目标 origin</Table.Th>
								<Table.Th>最近结果</Table.Th>
								<Table.Th>响应</Table.Th>
								<Table.Th>失败</Table.Th>
								<Table.Th>拒绝</Table.Th>
							</Table.Tr>
						</Table.Thead>
						<Table.Tbody>
							{items.map((item) => {
								const key = pluginNodeIndexKey(item.owner)
								const reference = formatPluginNodeReference(item.owner)
								return (
									<Table.Tr key={key}>
										<Table.Td>
											<Text size="sm" title={reference} style={wrapText}>
												{labels.get(key) ?? reference}
											</Text>
											{!filtered && (
												<Group gap="xs" wrap="nowrap">
													<Anchor
														component={RouterLinkAdapter}
														to={buildOutboundHttpNodeHref(item.owner)}
														size="xs"
													>
														出站设置
													</Anchor>
													<Anchor
														component={RouterLinkAdapter}
														to={buildOutboundHttpActivityHref(item.owner)}
														size="xs"
													>
														{hasRequestLogs ? '联网记录' : '联网摘要'}
													</Anchor>
												</Group>
											)}
										</Table.Td>
										<Table.Td>{dateTime.format(item.lastAttemptAt)}</Table.Td>
										<Table.Td style={wrapText}>{item.lastOrigin}</Table.Td>
										<Table.Td>
											{activityOutcome[item.lastOutcome]}
											{item.lastStatus === undefined ? '' : ` ${item.lastStatus}`}
											{item.lastCode && (
												<Text size="xs" c="dimmed" style={wrapText}>
													{item.lastCode}
												</Text>
											)}
										</Table.Td>
										<Table.Td>{item.received.toLocaleString()}</Table.Td>
										<Table.Td>{item.failed.toLocaleString()}</Table.Td>
										<Table.Td>{item.denied.toLocaleString()}</Table.Td>
									</Table.Tr>
								)
							})}
						</Table.Tbody>
					</Table>
				</Table.ScrollContainer>
			)}
		</Stack>
	)
})
