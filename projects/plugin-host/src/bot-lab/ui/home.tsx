import {
	Alert,
	Badge,
	Card,
	Group,
	Loader,
	MantineProvider,
	SimpleGrid,
	Stack,
	Text,
	Title,
} from '@mantine/core'
import { homeScope, homeSnapshot } from './home.scope'

function Home() {
	const { host } = homeScope.useWorkbench()
	const query = homeSnapshot.useQuery()
	return (
		<MantineProvider forceColorScheme={host.colorScheme}>
			<Stack p="md" gap="md">
				<Group justify="space-between">
					<Title order={2} size="h3">
						机器人工作区
					</Title>
					<Badge variant="light" color="yellow">
						模拟数据 · 真实插件 API
					</Badge>
				</Group>
				<Text size="sm" c="dimmed">
					先从官方“插件信息 →
					插件扩展”或顶部查找入口打开“机器人”左侧面板，再从共享列表选择机器人。不同来源的同名机器人各自拥有配置和会话；可以在多个标签中并行处理。
				</Text>
				{query.isPending && <Loader size="sm" />}
				{query.error && (
					<Alert color="red" title="读取工作区失败">
						{query.error instanceof Error ? query.error.message : String(query.error)}
					</Alert>
				)}
				{query.data && (
					<SimpleGrid cols={{ base: 1, sm: 3 }}>
						{query.data.sources.map((source) => (
							<Card key={source.id} withBorder padding="sm">
								<Group justify="space-between">
									<Text fw={600}>{source.label}</Text>
									<Badge size="xs" color={source.available ? 'teal' : 'orange'}>
										{source.available ? '可用' : '不可用'}
									</Badge>
								</Group>
								<Title order={3} mt="sm">
									{source.count}{' '}
									<Text span size="sm" fw={400}>
										个机器人
									</Text>
								</Title>
								<Text size="xs" c="dimmed" mt="xs">
									{source.capability}
								</Text>
							</Card>
						))}
					</SimpleGrid>
				)}
				<Card withBorder padding="sm">
					<Stack gap={6}>
						<Text fw={600} size="sm">
							开始工作
						</Text>
						<Text size="sm">
							打开“机器人”面板后，可以按来源或分组浏览，也可以搜索名称、账号和标识。重复选择会回到已打开的文档。
						</Text>
						<Text size="sm">
							标签上的“+”创建独立文档。实体配置和事件保留在中央；右侧来源信息、底部事件属于整个工作区。
						</Text>
						<Text size="xs" c="dimmed">
							这里连接本地模拟插件，不连接真实聊天平台。保存和启停会调用插件
							API，并同步到其他已打开的视图。
						</Text>
					</Stack>
				</Card>
			</Stack>
		</MantineProvider>
	)
}
export default homeScope.render(Home)
