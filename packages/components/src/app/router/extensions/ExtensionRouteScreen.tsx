import { Stack } from '@mantine/core'
import { useMemo } from 'react'
import { useParams } from '@tanstack/react-router'
import { type ExtensionRoutePrefix } from '../../../extension'
import { EXTENSION_ROUTE_PREFIX } from '../../../extension/paths'
import { PluginWorkbenchLoader } from '../../../workbench/runtime'
import { useCurrentPathname } from '../useCurrentRoute'
import { PluginRouteRenderer, useResolvedPluginRoute } from './PluginRouteRenderer'

function decodeURIComponentSafe(input: string): string {
	try {
		return decodeURIComponent(input)
	} catch {
		return input
	}
}

function normalizeExtensionRestPath(raw?: string): string {
	if (!raw) return ''
	const decoded = decodeURIComponentSafe(raw)
	const segments = decoded
		.split('/')
		.map((segment) => segment.trim())
		.filter((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
	if (segments.length === 0) return ''
	return `/${segments.join('/')}`
}

function readRestPathFromLocation(opts: {
	locationPath: string | null | undefined
	rawName: string
	prefix: ExtensionRoutePrefix
}): string {
	const { locationPath, rawName, prefix } = opts
	if (!locationPath) return ''
	const match = locationPath.match(
		prefix === EXTENSION_ROUTE_PREFIX ? /^\/ext\/([^/]+)(.*)$/ : /^\/ext-standalone\/([^/]+)(.*)$/,
	)
	if (!match) return ''
	const [, segment, rest] = match
	if (segment !== rawName) return ''
	return normalizeExtensionRestPath(rest)
}

export function ExtensionRouteScreen({ prefix }: { prefix: ExtensionRoutePrefix }) {
	const { pluginName: rawName, path: rawRest } = useParams({ strict: false })
	const locationPath = useCurrentPathname()
	const pluginName = decodeURIComponentSafe(rawName)

	const restPathFromParams = normalizeExtensionRestPath(rawRest)
	const restPathFromLocation = useMemo(() => {
		return readRestPathFromLocation({ locationPath, rawName, prefix })
	}, [locationPath, prefix, rawName])
	const restPath = restPathFromParams || restPathFromLocation
	const displayPath = `${prefix}/${pluginName}${restPath}`
	const ctxPathname =
		locationPath && locationPath.startsWith(`${prefix}/`) ? locationPath : displayPath

	const { pluginCtx, routeRender, routeVersion } = useResolvedPluginRoute({
		pluginName,
		pathname: ctxPathname,
		restPath,
	})

	return (
		<>
			<PluginWorkbenchLoader target={pluginName} />
			<PluginRouteRenderer
				pluginName={pluginName}
				displayPath={displayPath}
				pathname={ctxPathname}
				pluginCtx={pluginCtx}
				routeRender={routeRender}
				routeVersion={routeVersion}
				wrapContent={(content) => (
					<Stack gap="sm" style={{ flex: 1, minHeight: 0 }}>
						{content}
					</Stack>
				)}
			/>
		</>
	)
}
