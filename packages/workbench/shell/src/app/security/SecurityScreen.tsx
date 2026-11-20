import { ActionIcon, Badge, Button, Group, Loader, Stack, Text, Tooltip } from '@mantine/core'
import { IconRefresh } from '@tabler/icons-react'
import { useQuery } from '@tanstack/react-query'
import { runtimeErrorMessage, useRuntimeManagementClient } from '../../runtime'
import { ErrorState, PageHeader } from '../../components'
import { RouterLinkAdapter } from '../router/RouterLinkAdapter'
import { managementQueryKeys } from '../managementQuery'

export function SecurityScreen() {
	const security = useRuntimeManagementClient().security
	const overview = useQuery({
		queryKey: managementQueryKeys.securityOverview(),
		queryFn: () => security.readOverview(),
	})
	if (overview.isPending)
		return (
			<Group justify="center" p="xl" gap="xs">
				<Loader size="sm" />
				<Text c="dimmed">正在读取…</Text>
			</Group>
		)
	if (overview.error || !overview.data)
		return (
			<ErrorState
				title="无法读取安全状态"
				message={runtimeErrorMessage(overview.error, '读取失败')}
				onRetry={() => void overview.refetch()}
			/>
		)
	const access = overview.data.adminAccess
	const provider = access.provider
	return (
		<Stack gap="lg" p="var(--plx-page-padding)">
			<PageHeader
				title="认证与安全"
				meta={
					<Badge variant="light" color={provider?.ready ? 'green' : 'orange'}>
						{provider ? (provider.ready ? '远程登录可用' : '远程登录待配置') : '仅本地恢复'}
					</Badge>
				}
				actions={
					<>
						<Button component={RouterLinkAdapter} to="/security/audit" variant="subtle" size="xs">
							审计记录
						</Button>
						<Tooltip label="刷新">
							<ActionIcon
								variant="subtle"
								color="gray"
								aria-label="刷新"
								loading={overview.isFetching}
								onClick={() => void overview.refetch()}
							>
								<IconRefresh size={16} />
							</ActionIcon>
						</Tooltip>
					</>
				}
			/>
			<dl className="plx-facts">
				<dt>访问策略</dt>
				<dd>{access.policy}</dd>
				<dt>Provider</dt>
				<dd>{provider?.label ?? '无'}</dd>
				<dt>认证方式</dt>
				<dd>{provider?.method ?? '—'}</dd>
				<dt>远程状态</dt>
				<dd>{provider?.ready ? '就绪' : '需在本地完成配置'}</dd>
			</dl>
		</Stack>
	)
}
