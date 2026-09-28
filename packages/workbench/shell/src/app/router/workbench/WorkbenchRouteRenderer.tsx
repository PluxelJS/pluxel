import { Center, Stack, Text } from '@mantine/core'
import { type ReactNode } from 'react'
import type { WorkbenchResolvedRoute, WorkbenchTargetSnapshot } from '../../../workbench/client'
import { WorkbenchRoute, useWorkbenchRuntime } from '../../../workbench/runtime'
import { WorkbenchRouteStateFallback } from './WorkbenchRouteStatus'
import { pluginNodeIndexKey, type PluginNodeAddress } from '@pluxel/core'

export function WorkbenchRouteRenderer(props: {
	target: PluginNodeAddress
	displayName: string
	displayPath: string
	pathname: string
	route: WorkbenchResolvedRoute | undefined
	snapshot: WorkbenchTargetSnapshot
	backContent?: ReactNode
	wrapContent?: (content: ReactNode) => ReactNode
}) {
	const { target, displayName, displayPath, route, snapshot, backContent, wrapContent } = props
	const host = useWorkbenchRuntime()
	const pluginRunning = host.runningPluginKeys.has(pluginNodeIndexKey(target))

	if (!pluginRunning && host.runningPluginsReady) {
		return (
			<Center style={{ flex: 1 }}>
				<Stack gap="xs" align="center">
					<Text fw={600}>插件未运行</Text>
					<Text c="dimmed" size="sm" ta="center">
						请先启动插件 {displayName}，才能访问 {displayPath}
					</Text>
					{backContent ?? null}
				</Stack>
			</Center>
		)
	}

	if (snapshot.state !== 'ready' && !snapshot.layout) {
		return <WorkbenchRouteStateFallback displayName={displayName} snapshot={snapshot} />
	}

	if (!route) {
		return (
			<Center style={{ flex: 1 }}>
				<Stack gap="xs" align="center">
					<Text fw={600}>找不到扩展页面</Text>
					<Text c="dimmed" size="sm" ta="center">
						该插件尚未注册页面：{displayPath}
					</Text>
					{backContent ?? null}
				</Stack>
			</Center>
		)
	}

	const content = <WorkbenchRoute route={route} snapshot={snapshot} />

	return <>{wrapContent ? wrapContent(content) : content}</>
}
