import { Center, Loader, Stack, Text } from '@mantine/core'
import { useMemo } from 'react'
import { useParams } from '@tanstack/react-router'
import {
	ExtensionErrorBoundary,
	ExtensionProvider,
	EXTENSION_STANDALONE_ROUTE_PREFIX,
	getPluginRouteComponent,
	type ExtensionContext,
	type PluginExtensionContext,
	useExtensionContext,
	useExtensionRuntimeVersion,
} from '../../../extension'
import { useCurrentPathname } from '../../router/useCurrentRoute'
import { decodeURIComponentSafe, normalizeExtensionRestPath, readRestPathFromLocation } from './utils'

export function ExtensionStandaloneRoute() {
	const { pluginName: rawName, path: rawRest } = useParams({})
	const locationPath = useCurrentPathname()
	const pluginName = decodeURIComponentSafe(rawName)

	const restPathFromParams = normalizeExtensionRestPath(rawRest)
	const restPathFromLocation = useMemo(() => {
		return readRestPathFromLocation({
			locationPath,
			rawName,
			prefix: EXTENSION_STANDALONE_ROUTE_PREFIX,
		})
	}, [locationPath, rawName])
	const restPath = restPathFromParams || restPathFromLocation
	const displayPath = `${EXTENSION_STANDALONE_ROUTE_PREFIX}/${pluginName}${restPath}`
	const ctxPathname =
		locationPath && locationPath.startsWith(`${EXTENSION_STANDALONE_ROUTE_PREFIX}/`)
			? locationPath
			: displayPath
	const routeVersion = useExtensionRuntimeVersion(pluginName)

	const routeRender = useMemo(() => {
		return getPluginRouteComponent(pluginName, restPath)
	}, [pluginName, restPath, routeVersion])

	const parentCtx = useExtensionContext()
	const runningPlugins = parentCtx.runningPlugins
	const runningPluginsReady = parentCtx.runningPluginsReady
	const pluginRunning = runningPlugins.has(pluginName)

	const extensionCtx = useMemo<ExtensionContext>(
		() => ({
			...parentCtx,
			pathname: ctxPathname,
			pluginName,
		}),
		[parentCtx, ctxPathname, pluginName],
	)

	if (!pluginRunning && runningPluginsReady) {
		return (
			<Center style={{ flex: 1 }}>
				<Stack gap="xs" align="center">
					<Text fw={600}>插件未运行</Text>
					<Text c="dimmed" size="sm">
						请先启动插件 {pluginName}，才能访问 {displayPath}
					</Text>
				</Stack>
			</Center>
		)
	}

	if (routeVersion === 0) {
		return (
			<Center style={{ flex: 1 }}>
				<Stack gap="xs" align="center">
					<Loader size="sm" />
					<Text fw={600}>扩展模块加载中</Text>
					<Text c="dimmed" size="sm">
						正在初始化插件 UI，请稍候…
					</Text>
				</Stack>
			</Center>
		)
	}

	if (!routeRender) {
		return (
			<Center style={{ flex: 1 }}>
				<Stack gap="xs" align="center">
					<Text fw={600}>找不到扩展页面</Text>
					<Text c="dimmed" size="sm">
						该插件尚未注册页面：{displayPath}
					</Text>
				</Stack>
			</Center>
		)
	}

	const pluginCtx = extensionCtx as PluginExtensionContext

	return (
		<ExtensionProvider value={pluginCtx}>
			<ExtensionErrorBoundary
				pluginName={pluginName}
				extensionId={`${pluginName}:${ctxPathname}`}
				point={`route:${ctxPathname}`}
			>
				{routeRender(pluginCtx)}
			</ExtensionErrorBoundary>
		</ExtensionProvider>
	)
}
