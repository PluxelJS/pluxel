import { Center, Stack, Text } from '@mantine/core'
import { useMemo } from 'react'
import { useParams } from '@tanstack/react-router'
import {
	ExtensionErrorBoundary,
	ExtensionProvider,
	getRouteComponent,
	type ExtensionContext,
	useExtensionContext,
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
	let pluginName = rawName
	try {
		pluginName = decodeURIComponent(rawName)
	} catch {
		pluginName = rawName
	}

	const restPath = normalizeExtensionRestPath(rawRest)
	const fullPath = `/ext/${pluginName}${restPath}`
	const ExtensionComponent = getRouteComponent(fullPath)

	const parentCtx = useExtensionContext()
	const extensionCtx = useMemo<ExtensionContext>(
		() => ({
			...parentCtx,
			pathname: fullPath,
			pluginName,
		}),
		[parentCtx, fullPath, pluginName],
	)

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
