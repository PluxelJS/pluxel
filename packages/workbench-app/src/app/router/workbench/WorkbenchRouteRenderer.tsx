import { Center, Stack, Text } from '@mantine/core'
import { type ReactNode } from 'react'
import type { WorkbenchResolvedRoute, WorkbenchTargetSnapshot } from '../../../workbench/client'
import { WorkbenchRoute, useWorkbenchRuntime } from '../../../workbench/runtime'
import { WorkbenchRouteStateFallback, WorkbenchRouteStatusBanner } from './WorkbenchRouteStatus'

export function WorkbenchRouteRenderer(props: {
	pluginName: string
	displayPath: string
	pathname: string
	route: WorkbenchResolvedRoute | undefined
	snapshot: WorkbenchTargetSnapshot
	backContent?: ReactNode
	wrapContent?: (content: ReactNode) => ReactNode
}) {
	const { pluginName, displayPath, route, snapshot, backContent, wrapContent } = props
	const host = useWorkbenchRuntime()
	const pluginRunning = host.runningPlugins.has(pluginName)

	if (!pluginRunning && host.runningPluginsReady) {
		return (
			<Center style={{ flex: 1 }}>
				<Stack gap="xs" align="center">
					<Text fw={600}>插件未运行</Text>
					<Text c="dimmed" size="sm" ta="center">
						请先启动插件 {pluginName}，才能访问 {displayPath}
					</Text>
					{backContent ?? null}
				</Stack>
			</Center>
		)
	}

	if (snapshot.state !== 'ready' && !snapshot.layout) {
		return <WorkbenchRouteStateFallback pluginName={pluginName} snapshot={snapshot} />
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

	const content = (
		<>
			<WorkbenchRouteStatusBanner pluginName={pluginName} />
			<WorkbenchRoute target={pluginName} route={route} />
		</>
	)

	return <>{wrapContent ? wrapContent(content) : content}</>
}
