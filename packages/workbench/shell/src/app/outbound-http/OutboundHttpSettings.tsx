import { Alert, Anchor, Group, Loader, Paper, Stack, Text, Title } from '@mantine/core'
import type { PluginNodeAddress } from '@pluxel/core'
import { useQuery } from '@tanstack/react-query'
import { ErrorState } from '../../components'
import { runtimeErrorMessage, useRuntimeManagementClient } from '../../runtime'
import { managementQueryKeys } from '../managementQuery'
import { RouterLinkAdapter } from '../router/RouterLinkAdapter'
import { RefreshAction } from '../workbench/RefreshAction'
import { OutboundHttpEditor } from './OutboundHttpEditor'
import { buildOutboundHttpActivityHref } from './paths'

export function OutboundHttpSettings({ owner }: { owner: PluginNodeAddress | null }) {
	const management = useRuntimeManagementClient()
	const query = useQuery({
		queryKey: managementQueryKeys.outboundHttpScope(owner),
		queryFn: () => management.outboundHttp.get(owner),
	})
	const snapshot = query.data

	return (
		<Paper withBorder p="md" miw={0}>
			<Stack gap="md">
				<Group gap="sm">
					<Title order={2} size="h4">
						{owner ? '节点出站策略' : '宿主出站策略'}
					</Title>
					<RefreshAction
						label="刷新出站设置"
						loading={query.isFetching}
						onClick={() => void query.refetch()}
					/>
					{owner && snapshot?.managed && snapshot.records !== 'off' && (
						<Anchor
							component={RouterLinkAdapter}
							to={buildOutboundHttpActivityHref(owner)}
							size="sm"
						>
							{snapshot.records === 'summary' ? '本节点联网摘要' : '本节点联网记录'}
						</Anchor>
					)}
				</Group>
				{snapshot ? (
					<>
						{query.isRefetchError && (
							<Alert color="red" title="刷新出站设置失败">
								{runtimeErrorMessage(query.error)}
							</Alert>
						)}
						{snapshot.managed ? (
							<OutboundHttpEditor snapshot={snapshot} />
						) : (
							<Text size="sm" c="dimmed">
								此宿主的出站传输由部署声明决定。
							</Text>
						)}
					</>
				) : query.isPending ? (
					<Group role="status">
						<Loader size="sm" />
						<Text size="sm" c="dimmed">
							正在读取出站设置…
						</Text>
					</Group>
				) : (
					<ErrorState
						title="出站设置不可用"
						message={runtimeErrorMessage(query.error)}
						onRetry={() => void query.refetch()}
					/>
				)}
			</Stack>
		</Paper>
	)
}
