import { Badge, Card, Group, ScrollArea, Stack, Table, Text, Title } from '@mantine/core'
import { AccessEditor } from './access-editor.tsx'
import { accessUi } from './runtime.ts'

export function AccessPanel() {
	const model = accessUi.useResources()
	const overview = model.overview.useQuery().rows.find((item) => item.id === 'overview')
	const users = model.users.useQuery().rows
	return (
		<Stack p="md" gap="md">
			<Group justify="space-between">
				<div>
					<Title order={4}>统一用户与权限</Title>
					<Text size="sm" c="dimmed">
						平台身份自动归并到稳定用户；命令权限默认拒绝未知节点。
					</Text>
				</div>
				<Badge>{overview?.users ?? 0} users</Badge>
			</Group>
			<Group grow>
				<Card withBorder>
					<Text size="xs" c="dimmed">
						平台身份
					</Text>
					<Title order={3}>{overview?.identities ?? 0}</Title>
				</Card>
				<Card withBorder>
					<Text size="xs" c="dimmed">
						角色
					</Text>
					<Title order={3}>{overview?.roles ?? 0}</Title>
				</Card>
				<Card withBorder>
					<Text size="xs" c="dimmed">
						权限节点
					</Text>
					<Title order={3}>{overview?.permissions ?? 0}</Title>
				</Card>
			</Group>
			<Card withBorder>
				<ScrollArea>
					<Table striped highlightOnHover>
						<Table.Thead>
							<Table.Tr>
								<Table.Th>用户</Table.Th>
								<Table.Th>显示名</Table.Th>
								<Table.Th>身份</Table.Th>
							</Table.Tr>
						</Table.Thead>
						<Table.Tbody>
							{users.map((user) => (
								<Table.Tr key={user.id}>
									<Table.Td>{user.id}</Table.Td>
									<Table.Td>{user.displayName ?? '-'}</Table.Td>
									<Table.Td>
										{user.identities
											.map((item) => `${item.platform}:${item.username ?? item.actorId}`)
											.join(', ')}
									</Table.Td>
								</Table.Tr>
							))}
						</Table.Tbody>
					</Table>
				</ScrollArea>
			</Card>
			<AccessEditor app={{ model }} />
		</Stack>
	)
}
