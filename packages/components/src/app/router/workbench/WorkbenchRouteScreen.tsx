import { Stack } from '@mantine/core'
import { useMemo } from 'react'
import { useParams } from '@tanstack/react-router'
import { type WorkbenchRoutePrefix, WORKBENCH_ROUTE_PREFIX } from '../../../workbench/paths'
import { WorkbenchTargetProvider, useResolvedWorkbenchRoute } from '../../../workbench/runtime'
import { useCurrentPathname } from '../useCurrentRoute'
import { WorkbenchRouteRenderer } from './WorkbenchRouteRenderer'

function decodeURIComponentSafe(input: string): string {
	try {
		return decodeURIComponent(input)
	} catch {
		return input
	}
}

function normalizeWorkbenchRestPath(raw?: string): string {
	if (!raw) return ''
	const segments = raw
		.split('/')
		.map((segment) => segment.trim())
		.filter((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
	if (segments.length === 0) return ''
	return `/${segments.join('/')}`
}

function readRestPathFromLocation(opts: {
	locationPath: string | null | undefined
	rawName: string
	prefix: WorkbenchRoutePrefix
}): string {
	const { locationPath, rawName, prefix } = opts
	if (!locationPath) return ''
	const match = locationPath.match(
		prefix === WORKBENCH_ROUTE_PREFIX ? /^\/ext\/([^/]+)(.*)$/ : /^\/ext-standalone\/([^/]+)(.*)$/,
	)
	if (!match) return ''
	const [, segment, rest] = match
	if (segment !== rawName) return ''
	return normalizeWorkbenchRestPath(rest)
}

export function WorkbenchRouteScreen({ prefix }: { prefix: WorkbenchRoutePrefix }) {
	const { pluginName: rawName, path: rawRest } = useParams({ strict: false })
	const locationPath = useCurrentPathname()
	const pluginName = decodeURIComponentSafe(rawName)

	const restPathFromParams = normalizeWorkbenchRestPath(rawRest)
	const restPathFromLocation = useMemo(() => {
		return readRestPathFromLocation({ locationPath, rawName, prefix })
	}, [locationPath, prefix, rawName])
	// The location keeps percent-encoded segment boundaries intact. Route params may
	// already be decoded by the router, so only use them as a fallback.
	const restPath = restPathFromLocation || restPathFromParams
	const displayPath = `${prefix}/${pluginName}${restPath}`
	const ctxPathname =
		locationPath && locationPath.startsWith(`${prefix}/`) ? locationPath : displayPath

	return (
		<WorkbenchTargetProvider target={pluginName} pathname={ctxPathname}>
			<ResolvedRoute
				displayPath={displayPath}
				pathname={ctxPathname}
				pluginName={pluginName}
				restPath={restPath}
			/>
		</WorkbenchTargetProvider>
	)
}

function ResolvedRoute({
	pluginName,
	displayPath,
	pathname,
	restPath,
}: {
	pluginName: string
	displayPath: string
	pathname: string
	restPath: string
}) {
	const { route, snapshot } = useResolvedWorkbenchRoute(pluginName, restPath)
	return (
		<WorkbenchRouteRenderer
			pluginName={pluginName}
			displayPath={displayPath}
			pathname={pathname}
			route={route}
			snapshot={snapshot}
			wrapContent={(content) => (
				<Stack gap="sm" style={{ flex: 1, minHeight: 0 }}>
					{content}
				</Stack>
			)}
		/>
	)
}
