import { Alert, Badge, Center, Loader, Stack, Text } from '@mantine/core'
import { ErrorState } from '../../../components'
import type { WorkbenchTargetSnapshot } from '../../../workbench/client'
import { useWorkbenchArtifactState } from '../../../workbench/runtime'
import type { PluginNodeAddress } from '@pluxel/core'

export function WorkbenchRouteStateFallback({
	target,
	displayName,
	snapshot,
}: {
	target: PluginNodeAddress
	displayName: string
	snapshot: WorkbenchTargetSnapshot
}) {
	const artifact = useWorkbenchArtifactState(target)
	if (snapshot.layout) return null
	if (snapshot.state === 'error' || artifact?.state === 'error') {
		return (
			<ErrorState
				title="管理界面构建失败"
				message={snapshot.error?.message ?? artifact?.message ?? displayName}
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
					{displayName}
				</Text>
			</Stack>
		</Center>
	)
}

export function WorkbenchRouteStatusBanner({ target }: { target: PluginNodeAddress }) {
	const artifact = useWorkbenchArtifactState(target)
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
