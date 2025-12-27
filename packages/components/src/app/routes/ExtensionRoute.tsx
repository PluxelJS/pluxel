import { Center, Loader, Stack, Text } from '@mantine/core'
import { useMemo } from 'react'
import { useParams, useRouterState } from '@tanstack/react-router'
import {
	ExtensionErrorBoundary,
	ExtensionProvider,
	getPluginRouteComponent,
	type ExtensionContext,
	useExtensionContext,
	useExtensionRuntimeVersion,
} from '../../extension'

function normalizeExtensionRestPath(raw?: string): string {
	if (!raw) return ''
	let decoded = raw
	try {
		decoded = decodeURIComponent(raw)
	} catch {
		decoded = raw
	}
	const segments = decoded
		.split('/')
		.map((segment) => segment.trim())
		.filter((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
	if (segments.length === 0) return ''
	return `/${segments.join('/')}`
}

export function ExtensionRoute() {
	const { pluginName: rawName, path: rawRest } = useParams({ from: '/ext/$pluginName/$path*' })
	const locationPath = useRouterState({ select: (state) => state.location.pathname })
	let pluginName = rawName
	try {
		pluginName = decodeURIComponent(rawName)
	} catch {
		pluginName = rawName
	}

	const restPathFromParams = normalizeExtensionRestPath(rawRest)
	const restPathFromLocation = useMemo(() => {
		if (!locationPath) return ''
		const match = locationPath.match(/^\/ext\/([^/]+)(.*)$/)
		if (!match) return ''
		const [, segment, rest] = match
		if (segment !== rawName) return ''
		return normalizeExtensionRestPath(rest)
	}, [locationPath, rawName])
	const restPath = restPathFromParams || restPathFromLocation
	const fullPath = `/ext/${pluginName}${restPath}`
	const routeVersion = useExtensionRuntimeVersion(pluginName)

	const ExtensionComponent = useMemo(() => {
		return getPluginRouteComponent(pluginName, restPath)
	}, [pluginName, restPath, routeVersion])

	const parentCtx = useExtensionContext()
	const runningPlugins = parentCtx.runningPlugins
	const runningPluginsReady = parentCtx.runningPluginsReady
	const pluginRunning = runningPlugins.has(pluginName)

	const extensionCtx = useMemo<ExtensionContext>(
		() => ({
			...parentCtx,
			pathname: fullPath,
			pluginName,
		}),
		[parentCtx, fullPath, pluginName],
	)

	if (!pluginRunning && runningPluginsReady) {
		return (
			<Center style={{ flex: 1 }}>
				<Stack gap="xs" align="center">
					<Text fw={600}>插件未运行</Text>
					<Text c="dimmed" size="sm">
						请先启动插件 {pluginName}，才能访问 {fullPath}
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

	if (!ExtensionComponent) {
		return (
			<Center style={{ flex: 1 }}>
				<Stack gap="xs" align="center">
					<Text fw={600}>找不到扩展页面</Text>
					<Text c="dimmed" size="sm">
						该插件尚未注册页面：{fullPath}
					</Text>
				</Stack>
			</Center>
		)
	}

	return (
		<ExtensionProvider value={extensionCtx}>
			<ExtensionErrorBoundary
				pluginName={pluginName}
				extensionId={`${pluginName}:${fullPath}`}
				point={`route:${fullPath}`}
			>
				<ExtensionComponent />
			</ExtensionErrorBoundary>
		</ExtensionProvider>
	)
}
