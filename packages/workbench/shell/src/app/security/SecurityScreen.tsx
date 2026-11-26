import { Badge, DataList, Group, Loader, Paper, Stack, Text, Title } from '@mantine/core'
import { useQuery } from '@tanstack/react-query'
import { runtimeErrorMessage, useRuntimeManagementClient } from '../../runtime'
import { ErrorState } from '../../components'
import { managementQueryKeys } from '../managementQuery'
import { RefreshAction } from '../workbench/RefreshAction'

export function SecurityScreen() {
	const security = useRuntimeManagementClient().security
	const overview = useQuery({
		queryKey: managementQueryKeys.securityOverview(),
		queryFn: () => security.readOverview(),
	})
	if (overview.isPending)
		return (
			<Group role="status" justify="center" p="xl">
				<Loader size="sm" />
				<Text c="dimmed">正在读取访问状态…</Text>
			</Group>
		)
	if (overview.error || !overview.data)
		return (
			<ErrorState
				title="无法读取访问状态"
				message={runtimeErrorMessage(overview.error, '加载访问状态失败')}
				onRetry={() => void overview.refetch()}
			/>
		)
	const access = overview.data.adminAccess
	const fields = [
		{ label: '访问策略', value: access.policy },
		{ label: '认证提供方', value: access.provider?.label ?? '未配置' },
		{ label: '认证模式', value: access.provider?.method ?? '未配置' },
		{
			label: '远程状态',
			value: (
				<Badge color={access.provider?.ready ? 'green' : 'orange'}>
					{access.provider ? (access.provider.ready ? '已就绪' : '待配置') : '仅本机恢复'}
				</Badge>
			),
		},
	]
	return (
		<Paper withBorder p="md" miw={0}>
			<Stack gap="md">
				<Group gap="xs">
					<Title order={2} size="h4">
						管理访问
					</Title>
					<RefreshAction
						label="刷新访问状态"
						loading={overview.isFetching}
						onClick={() => void overview.refetch()}
					/>
				</Group>
				<DataList
					orientation="vertical"
					style={{
						display: 'grid',
						gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 11rem), 1fr))',
						overflowWrap: 'anywhere',
					}}
				>
					{fields.map(({ label, value }) => (
						<DataList.Item key={label}>
							<DataList.ItemLabel>{label}</DataList.ItemLabel>
							<DataList.ItemValue>{value}</DataList.ItemValue>
						</DataList.Item>
					))}
				</DataList>
			</Stack>
		</Paper>
	)
}
