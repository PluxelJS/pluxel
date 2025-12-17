import { Center, Stack, Text, Title } from '@mantine/core'
import { PluginsLayout } from '../plugins/list'

export function PluginsRoute() {
	return <PluginsLayout />
}

export function PluginsPlaceholder() {
	return (
		<Center style={{ flex: 1 }}>
			<Stack align="center" gap="xs">
				<Title order={4}>欢迎探索插件</Title>
				<Text c="dimmed">在左侧选择一个插件即可查看详情和配置。</Text>
			</Stack>
		</Center>
	)
}
