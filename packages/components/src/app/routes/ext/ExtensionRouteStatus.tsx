import { Alert, Badge, Button, Center, Group, Loader, Stack, Text } from '@mantine/core'
import { IconAlertTriangle, IconRefresh } from '@tabler/icons-react'
import { ErrorState } from '../../../components'
import { requestExtensionManifestSync, useExtensionModuleState } from '../../../extension'

function fallbackMessage(pluginName: string): string {
	return `插件 ${pluginName} 的前端正在初始化，完成后会自动显示最新界面。`
}

function compileErrorMessage(pluginName: string, message?: string): string {
	if (message?.trim()) return message.trim()
	return `插件 ${pluginName} 的前端编译失败，修复后保存即可自动重试。`
}

function renderSyncMeta(updatedAt?: number) {
	if (!updatedAt) return null
	return (
		<Badge size="xs" variant="light" color="gray">
			{new Date(updatedAt).toLocaleTimeString()}
		</Badge>
	)
}

export function ExtensionRouteStateFallback({
	pluginName,
	routeVersion,
}: {
	pluginName: string
	routeVersion: number
}) {
	const moduleState = useExtensionModuleState(pluginName)

	if (routeVersion > 0) return null

	if (moduleState?.state === 'error') {
		return (
			<ErrorState
				title="插件 UI 编译失败"
				message={compileErrorMessage(pluginName, moduleState.message)}
				onRetry={() => requestExtensionManifestSync(true)}
				retryLabel="重新同步"
				withBorder
				minHeight="100%"
			/>
		)
	}

	const isBuilding = moduleState?.state === 'building'

	return (
		<Center style={{ flex: 1 }}>
			<Stack gap="xs" align="center">
				<Loader size="sm" />
				<Text fw={600}>{isBuilding ? '插件 UI 构建中' : '扩展模块加载中'}</Text>
				<Text c="dimmed" size="sm" ta="center">
					{isBuilding
						? `正在为 ${pluginName} 构建最新前端资源，完成后会自动热替换。`
						: fallbackMessage(pluginName)}
				</Text>
			</Stack>
		</Center>
	)
}

export function ExtensionRouteStatusBanner({ pluginName }: { pluginName: string }) {
	const moduleState = useExtensionModuleState(pluginName)

	if (moduleState?.state === 'building') {
		return (
			<Alert
				color="yellow"
				variant="light"
				radius="md"
				title="插件 UI 正在热更新"
				icon={<Loader size={16} />}
			>
				<Stack gap={6}>
					<Text size="sm" c="dimmed">
						当前保留上一个可用版本，新的前端资源完成构建后会自动替换。
					</Text>
					<Group gap="xs">
						<Badge size="xs" variant="light" color="yellow">
							HMR
						</Badge>
						{renderSyncMeta(moduleState.updatedAt)}
					</Group>
				</Stack>
			</Alert>
		)
	}

	if (moduleState?.state === 'error') {
		return (
			<Alert
				color="red"
				variant="light"
				radius="md"
				title="插件 UI 最新编译失败"
				icon={<IconAlertTriangle size={16} />}
			>
				<Stack gap={8}>
					<Text size="sm">{compileErrorMessage(pluginName, moduleState.message)}</Text>
					<Group gap="xs">
						{renderSyncMeta(moduleState.updatedAt)}
						<Button
							size="xs"
							variant="light"
							color="red"
							leftSection={<IconRefresh size={14} />}
							onClick={() => requestExtensionManifestSync(true)}
						>
							重新同步
						</Button>
					</Group>
				</Stack>
			</Alert>
		)
	}

	return null
}
