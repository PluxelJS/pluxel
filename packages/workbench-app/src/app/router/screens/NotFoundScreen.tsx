import { Center, Stack, Text, Title } from '@mantine/core'
import { EmptyState } from '../../../components'
import { useCurrentPathname } from '../useCurrentRoute'

export function NotFoundScreen() {
	const path = useCurrentPathname()
	return (
		<Center style={{ flex: 1 }}>
			<Stack align="center" gap="xs" maw={520}>
				<EmptyState
					title="页面不存在"
					description={path ? `未找到路由：${path}` : '未找到路由'}
					minHeight={220}
				/>
				<Title order={6} c="dimmed">
					可能的原因
				</Title>
				<Text size="sm" c="dimmed" ta="center">
					链接拼写错误，或插件/扩展已卸载。
				</Text>
			</Stack>
		</Center>
	)
}
