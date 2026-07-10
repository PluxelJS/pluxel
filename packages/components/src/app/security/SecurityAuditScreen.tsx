import { Badge, Button, Group, Loader, Paper, Stack, Table, Text } from '@mantine/core'
import { IconRefresh } from '@tabler/icons-react'
import { useEffect, useEffectEvent, useState } from 'react'
import { getRuntimeSecurityClient, type SecurityAuditEvent, rpcErrorMessage } from '../../runtime'
import { EmptyState, ErrorState } from '../../components'

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
	const security = getRuntimeSecurityClient()
	const [events, setEvents] = useState<SecurityAuditEvent[]>([])
	const [loading, setLoading] = useState(true)
	const [refreshing, setRefreshing] = useState(false)
	const [error, setError] = useState<string | null>(null)

	const refresh = useEffectEvent(async () => {
		setRefreshing(true)
		setError(null)
		try {
			setEvents(await security.listEvents())
		} catch (cause) {
			setError(rpcErrorMessage(cause, 'Failed to load security audit events'))
		} finally {
			setLoading(false)
			setRefreshing(false)
		}
	})

	useEffect(() => {
		void refresh()
	}, [])

	if (loading) {
		return (
			<Group justify="center" p="xl">
				<Loader size="sm" />
				<Text c="dimmed">Loading audit events</Text>
			</Group>
		)
	}

	if (error) {
		return (
			<ErrorState title="Audit events unavailable" message={error} onRetry={() => void refresh()} />
		)
	}

	const failures = events.filter((event) => event.status === 'failure').length

	return (
		<Stack gap="sm" style={{ flex: 1, minHeight: 0 }}>
			<Paper withBorder p="sm" radius="sm">
				<Group justify="space-between" align="center" wrap="wrap" gap="xs">
					<Group gap={6} wrap="wrap">
						<Badge variant="light" color="gray">
							事件 {events.length}
						</Badge>
						<Badge variant="light" color={failures > 0 ? 'red' : 'gray'}>
							失败 {failures}
						</Badge>
					</Group>
					<Button
						leftSection={<IconRefresh size={16} />}
						variant="light"
						size="xs"
						loading={refreshing}
						onClick={() => void refresh()}
					>
						刷新
					</Button>
				</Group>
			</Paper>

			<Paper withBorder p="sm" radius="sm" style={{ flex: 1, minHeight: 0 }}>
				{events.length === 0 ? (
					<EmptyState title="暂无事件" description="安全事件会显示在这里。" minHeight="100%" />
				) : (
					<div style={tableWrapStyle}>
						<Table striped highlightOnHover verticalSpacing={6} miw={720}>
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
					</div>
				)}
			</Paper>
		</Stack>
	)
}
