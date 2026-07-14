import { Alert, Badge, Center, Loader, Stack, Text } from '@mantine/core'
import { ErrorState } from '../../../components'
import { useWorkbenchArtifactState } from '../../../workbench/runtime'

export function ExtensionRouteStateFallback({
	pluginName,
	routeVersion,
}: {
	pluginName: string
	routeVersion: number
}) {
	const artifact = useWorkbenchArtifactState(pluginName)
	if (routeVersion > 0) return null
	if (artifact?.state === 'error') {
		return (
			<ErrorState
				title="管理界面构建失败"
				message={artifact.message ?? pluginName}
				withBorder
				minHeight="100%"
			/>
		)
	}
	return (
		<Center style={{ flex: 1 }}>
			<Stack gap="xs" align="center">
				<Loader size="sm" />
				<Text fw={600}>{artifact?.state === 'building' ? '管理界面构建中' : '管理界面加载中'}</Text>
				<Text c="dimmed" size="sm" ta="center">
					{pluginName}
				</Text>
			</Stack>
		</Center>
	)
}

export function ExtensionRouteStatusBanner({ pluginName }: { pluginName: string }) {
	const artifact = useWorkbenchArtifactState(pluginName)
	if (artifact?.state !== 'building') return null
	return (
		<Alert
			color="yellow"
			variant="light"
			radius="md"
			title="管理界面正在热更新"
			icon={<Loader size={16} />}
		>
			<Badge size="xs" variant="light" color="yellow">
				HMR
			</Badge>
		</Alert>
	)
}
