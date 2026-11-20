import { Center, Stack } from '@mantine/core'
import { EmptyState } from '../../../components'
import { useCurrentPathname } from '../useCurrentRoute'

export function NotFoundScreen({ pathname }: { pathname?: string } = {}) {
	const routerPathname = useCurrentPathname()
	const path = pathname ?? routerPathname
	return (
		<Center style={{ flex: 1 }}>
			<Stack align="center" gap="xs" maw={520}>
				<EmptyState
					title="页面不存在"
					description={path ? `未找到路由：${path}` : '未找到路由'}
					minHeight={220}
				/>
			</Stack>
		</Center>
	)
}
