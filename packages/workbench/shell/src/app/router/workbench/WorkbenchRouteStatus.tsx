import { Center, Loader, Stack, Text } from '@mantine/core'
import { ErrorState } from '../../../components'
import type { WorkbenchTargetSnapshot } from '../../../workbench/client'

export function WorkbenchRouteStateFallback({
	displayName,
	snapshot,
}: {
	displayName: string
	snapshot: WorkbenchTargetSnapshot
}) {
	if (snapshot.layout) return null
	if (snapshot.state === 'error') {
		return (
			<ErrorState
				title="管理界面加载失败"
				message={snapshot.error?.message ?? displayName}
				withBorder
				minHeight="100%"
			/>
		)
	}
	return (
		<Center style={{ flex: 1 }}>
			<Stack gap="xs" align="center">
				<Loader size="sm" />
				<Text fw={600}>管理界面加载中</Text>
				<Text c="dimmed" size="sm" ta="center">
					{displayName}
				</Text>
			</Stack>
		</Center>
	)
}
