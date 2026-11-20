import { Alert, Button, Group, Loader, Stack, Text } from '@mantine/core'
import type { PluginNodeAddress } from '@pluxel/core'
import { useQuery } from '@tanstack/react-query'
import { ErrorState } from '../../components'
import { runtimeErrorMessage, useRuntimeManagementClient } from '../../runtime'
import { managementQueryKeys } from '../managementQuery'
import { RouterLinkAdapter } from '../router/RouterLinkAdapter'
import { OutboundHttpEditor } from './OutboundHttpEditor'
import { buildOutboundHttpActivityHref } from './paths'

export function OutboundHttpSettings({ owner }: { owner: PluginNodeAddress | null }) {
	const management = useRuntimeManagementClient()
	const query = useQuery({
		queryKey: managementQueryKeys.outboundHttpScope(owner),
		queryFn: () => management.outboundHttp.get(owner),
	})

	return (
		<Stack gap="md" w="100%" maw="48rem" miw={0}>
			<Group gap="xs" justify="flex-end">
				<Button
					component={RouterLinkAdapter}
					to={buildOutboundHttpActivityHref(owner ?? undefined)}
					size="compact-sm"
					variant="subtle"
				>
					{owner ? '本节点联网记录' : '出站总览'}
				</Button>
				<Button
					size="compact-sm"
					variant="default"
					loading={query.isFetching}
					onClick={() => void query.refetch()}
				>
					刷新
				</Button>
			</Group>
			{query.data ? (
				<>
					{query.isRefetchError && (
						<Alert color="red" title="刷新出站设置失败">
							{runtimeErrorMessage(query.error)}
						</Alert>
					)}
					<OutboundHttpEditor snapshot={query.data} />
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
	)
}
