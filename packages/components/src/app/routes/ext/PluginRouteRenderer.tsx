import { Center, Stack, Text } from '@mantine/core'
import { type ReactNode, useMemo } from 'react'
import {
	createPluginExtensionContext,
	ExtensionErrorBoundary,
	ExtensionPathnameProvider,
	ExtensionProvider,
	getPluginRouteComponent,
	type PluginExtensionContext,
	useExtensionContext,
	useExtensionRuntimeVersion,
} from '../../../extension'
import { ExtensionRouteStateFallback, ExtensionRouteStatusBanner } from './ExtensionRouteStatus'

type PluginRouteComponent = (ctx: PluginExtensionContext) => ReactNode

export function useResolvedPluginRoute(opts: {
	pluginName: string
	pathname: string
	restPath: string
}) {
	const { pluginName, pathname, restPath } = opts
	const baseCtx = useExtensionContext('global')
	const routeVersion = useExtensionRuntimeVersion(pluginName)

	const routeRender = useMemo(() => {
		return getPluginRouteComponent(pluginName, restPath)
	}, [pluginName, restPath, routeVersion])

	const pluginCtx = useMemo(
		() => createPluginExtensionContext(baseCtx, { pluginName, pathname }),
		[baseCtx, pathname, pluginName],
	)

	return { pluginCtx, routeRender, routeVersion }
}

export function PluginRouteRenderer(props: {
	pluginName: string
	displayPath: string
	pathname: string
	pluginCtx: PluginExtensionContext
	routeRender: PluginRouteComponent | undefined
	routeVersion: number
	backContent?: ReactNode
	wrapContent?: (content: ReactNode) => ReactNode
}) {
	const {
		pluginName,
		displayPath,
		pathname,
		pluginCtx,
		routeRender,
		routeVersion,
		backContent,
		wrapContent,
	} = props
	const pluginRunning = pluginCtx.runningPlugins.has(pluginName)

	if (!pluginRunning && pluginCtx.runningPluginsReady) {
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

	if (routeVersion === 0) {
		return <ExtensionRouteStateFallback pluginName={pluginName} routeVersion={routeVersion} />
	}

	if (!routeRender) {
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
		<ExtensionPathnameProvider value={pathname}>
			<ExtensionProvider value={pluginCtx}>
				<ExtensionRouteStatusBanner pluginName={pluginName} />
				<ExtensionErrorBoundary
					pluginName={pluginName}
					extensionId={`${pluginName}:route:${pathname}`}
					point={`route:${pathname}`}
				>
					{routeRender(pluginCtx)}
				</ExtensionErrorBoundary>
			</ExtensionProvider>
		</ExtensionPathnameProvider>
	)

	return <>{wrapContent ? wrapContent(content) : content}</>
}
