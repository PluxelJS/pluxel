import { Badge, Group, Loader, Paper, Stack, Table, Text, Title } from '@mantine/core'
import { useQuery } from '@tanstack/react-query'
import {
	type SecurityAuditEvent,
	runtimeErrorMessage,
	useRuntimeManagementClient,
} from '../../runtime'
import { EmptyState, ErrorState } from '../../components'
import { managementQueryKeys } from '../managementQuery'
import { RefreshAction } from '../workbench/RefreshAction'

const eventTimeFormatter = new Intl.DateTimeFormat(undefined, {
	dateStyle: 'short',
	timeStyle: 'short',
})

function toneForEventStatus(status: SecurityAuditEvent['status']): string {
	switch (status) {
		case 'success':
			return 'green'
		case 'failure':
			return 'red'
		default:
			return 'blue'
	}
}

export function SecurityAuditScreen() {
	const security = useRuntimeManagementClient().security
	const query = useQuery<readonly SecurityAuditEvent[]>({
		queryKey: managementQueryKeys.securityEvents(),
		queryFn: () => security.listEvents(),
	})
	const events = query.data ?? []
	const loading = query.isPending
	const refreshing = query.isFetching
	const error = query.error ? runtimeErrorMessage(query.error, '加载安全审计事件失败') : null

	if (loading) {
		return (
			<Group role="status" justify="center" p="xl">
				<Loader size="sm" />
				<Text c="dimmed">正在读取审计记录…</Text>
			</Group>
		)
	}

	if (error) {
		return (
			<ErrorState title="无法读取审计记录" message={error} onRetry={() => void query.refetch()} />
		)
	}

	const failures = events.filter((event) => event.status === 'failure').length

	return (
		<Stack gap="md" miw={0}>
			<Group gap="sm">
				<Title order={2} size="h4">
					审计事件
				</Title>
				<RefreshAction
					label="刷新审计记录"
					loading={refreshing}
					onClick={() => void query.refetch()}
				/>
				<Group gap="xs">
					<Badge variant="light" color="gray">
						事件 {events.length}
					</Badge>
					<Badge variant="light" color={failures > 0 ? 'red' : 'gray'}>
						失败 {failures}
					</Badge>
				</Group>
			</Group>

			<Paper withBorder p="sm">
				{events.length === 0 ? (
					<EmptyState title="暂无事件" description="安全事件会显示在这里。" minHeight="100%" />
				) : (
					<Table.ScrollContainer minWidth={720}>
						<Table striped highlightOnHover verticalSpacing={6}>
							<Table.Thead>
								<Table.Tr>
									<Table.Th>时间</Table.Th>
									<Table.Th>区域</Table.Th>
									<Table.Th>动作</Table.Th>
									<Table.Th>状态</Table.Th>
									<Table.Th>消息</Table.Th>
								</Table.Tr>
							</Table.Thead>
							<Table.Tbody>
								{events.map((event) => (
									<Table.Tr key={event.id}>
										<Table.Td>{eventTimeFormatter.format(new Date(event.at))}</Table.Td>
										<Table.Td>{event.area}</Table.Td>
										<Table.Td>{event.action}</Table.Td>
										<Table.Td>
											<Badge size="sm" color={toneForEventStatus(event.status)}>
												{event.status}
											</Badge>
										</Table.Td>
										<Table.Td>
											<Text size="sm" lineClamp={2}>
												{event.message ?? event.reason ?? '-'}
											</Text>
										</Table.Td>
									</Table.Tr>
								))}
							</Table.Tbody>
						</Table>
					</Table.ScrollContainer>
				)}
			</Paper>
		</Stack>
	)
}
