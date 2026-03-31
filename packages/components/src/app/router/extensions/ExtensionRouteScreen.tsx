import { Stack } from '@mantine/core'
import { useMemo } from 'react'
import { useParams } from '@tanstack/react-router'
import { type ExtensionRoutePrefix } from '../../../extension'
import { useCurrentPathname } from '../useCurrentRoute'
import {
	decodeURIComponentSafe,
	normalizeExtensionRestPath,
	readRestPathFromLocation,
} from './utils'
import { PluginRouteRenderer, useResolvedPluginRoute } from './PluginRouteRenderer'

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
	)
}
