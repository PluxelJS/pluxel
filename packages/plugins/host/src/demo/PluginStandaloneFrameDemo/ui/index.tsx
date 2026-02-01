import { Button, Group, Stack, Text, Title } from '@mantine/core'
import { IconArrowLeft } from '@tabler/icons-react'
import { definePluginUIModule } from '@pluxel/hmr/web'
import { useExtensionContext } from '@pluxel/hmr/web'

function StandalonePage() {
	const { pluginName } = useExtensionContext('plugin')
	return (
		<Stack gap="md" style={{ minHeight: '100dvh', padding: 24 }}>
			<Group justify="space-between" align="center">
				<Title order={2}>Standalone 插件页面</Title>
				<Button
					variant="light"
					leftSection={<IconArrowLeft size={16} />}
					component="a"
					href="/"
				>
					返回宿主
				</Button>
			</Group>
			<Text c="dimmed" size="sm">
				当前插件：{pluginName}
			</Text>
			<Text size="sm">
				此页面通过插件 <code>routes[].definition.frame = 'standalone'</code> 声明为“无宿主壳”的页面。
				仍运行在同一个 App 内：Mantine 主题、RPC/SSE 客户端、鉴权/端点保护策略不变。
			</Text>
		</Stack>
	)
}

export default definePluginUIModule({
	routes: [
		{
			definition: {
				path: '/standalone',
				title: 'Standalone Demo',
				addToNav: true,
				navPriority: 40,
				frame: 'standalone',
			},
			render: () => <StandalonePage />,
		},
	],
})
