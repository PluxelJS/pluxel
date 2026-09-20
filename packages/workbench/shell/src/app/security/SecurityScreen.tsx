import { Badge, Button, Group, Loader, Paper, Stack, Table, Text } from '@mantine/core'
import { useQuery } from '@tanstack/react-query'
import { runtimeErrorMessage, useRuntimeManagementClient } from '../../runtime'
import { ErrorState } from '../../components'
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
			<Group justify="center" p="xl">
				<Loader size="sm" />
				<Text>Loading security state</Text>
			</Group>
		)
	if (overview.error || !overview.data)
		return (
			<ErrorState
				title="Security state unavailable"
				message={runtimeErrorMessage(overview.error, 'Failed to load security state')}
				onRetry={() => void overview.refetch()}
			/>
		)
	const access = overview.data.adminAccess
	return (
		<Stack gap="sm">
			<Group justify="space-between">
				<Badge color={access.provider?.ready ? 'green' : 'orange'}>
					{access.provider
						? access.provider.method + (access.provider.ready ? ' ready' : ' setup required')
						: 'local recovery only'}
				</Badge>
				<Group>
					<Button component={RouterLinkAdapter} to="/security/audit" variant="light">
						打开审计
					</Button>
					<Button
						variant="light"
						loading={overview.isFetching}
						onClick={() => void overview.refetch()}
					>
						刷新
					</Button>
				</Group>
			</Group>
			<Paper withBorder p="sm">
				<Table>
					<Table.Tbody>
						<Table.Tr>
							<Table.Td>访问策略</Table.Td>
							<Table.Td>{access.policy}</Table.Td>
						</Table.Tr>
						<Table.Tr>
							<Table.Td>Provider</Table.Td>
							<Table.Td>{access.provider?.label ?? 'none'}</Table.Td>
						</Table.Tr>
						<Table.Tr>
							<Table.Td>认证模式</Table.Td>
							<Table.Td>{access.provider?.method ?? '-'}</Table.Td>
						</Table.Tr>
						<Table.Tr>
							<Table.Td>远程状态</Table.Td>
							<Table.Td>{access.provider?.ready ? 'ready' : 'local setup required'}</Table.Td>
						</Table.Tr>
					</Table.Tbody>
				</Table>
			</Paper>
		</Stack>
	)
}
