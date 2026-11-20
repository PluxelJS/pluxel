import { ActionIcon, Badge, Group, Loader, Stack, Table, Text, Tooltip } from '@mantine/core'
import { IconRefresh } from '@tabler/icons-react'
import { useQuery } from '@tanstack/react-query'
import {
	type SecurityAuditEvent,
	runtimeErrorMessage,
	useRuntimeManagementClient,
} from '../../runtime'
import { EmptyState, ErrorState, PageHeader } from '../../components'
import { managementQueryKeys } from '../managementQuery'

const eventTimeFormatter = new Intl.DateTimeFormat(undefined, {
	dateStyle: 'short',
	timeStyle: 'short',
})

const tableWrapStyle = {
	overflowX: 'auto' as const,
}

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
	const error = query.error ? runtimeErrorMessage(query.error, '读取失败') : null

	if (loading) {
		return (
			<Group justify="center" p="xl" gap="xs">
				<Loader size="sm" />
				<Text c="dimmed">正在读取…</Text>
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
		<Stack gap="md" p="var(--plx-page-padding)" style={{ flex: 1, minHeight: 0 }}>
			<PageHeader
				title="安全审计"
				meta={
					<>
						{events.length} 条
						{failures > 0 ? <Text span c="red" size="xs">{` · ${failures} 条失败`}</Text> : null}
					</>
				}
				actions={
					<Tooltip label="刷新">
						<ActionIcon
							variant="subtle"
							color="gray"
							aria-label="刷新"
							loading={refreshing}
							onClick={() => void query.refetch()}
						>
							<IconRefresh size={16} />
						</ActionIcon>
					</Tooltip>
				}
			/>

			<div style={{ flex: 1, minHeight: 0 }}>
				{events.length === 0 ? (
					<EmptyState title="暂无记录" minHeight="100%" />
				) : (
					<div style={tableWrapStyle}>
						<Table highlightOnHover verticalSpacing={8} miw={720} className="plx-table">
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
											<Badge size="sm" variant="light" color={toneForEventStatus(event.status)}>
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
					</div>
				)}
			</div>
		</Stack>
	)
}
