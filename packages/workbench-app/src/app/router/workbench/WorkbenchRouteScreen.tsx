import { Stack } from '@mantine/core'
import { useMemo } from 'react'
import { useParams } from '@tanstack/react-router'
import {
	buildWorkbenchHref,
	getWorkbenchFrame,
	parseWorkbenchHref,
	type WorkbenchRoutePrefix,
} from '../../../workbench/paths'
import { decodeWorkbenchNodeSegment, workbenchNodeKey } from '../../../workbench/node-address'
import type { PluginNodeAddressSnapshot } from '@pluxel/core'
import { WorkbenchTargetProvider, useResolvedWorkbenchRoute } from '../../../workbench/runtime'
import { useCurrentPathname } from '../useCurrentRoute'
import { WorkbenchRouteRenderer } from './WorkbenchRouteRenderer'

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
	target: PluginNodeAddressSnapshot
	prefix: WorkbenchRoutePrefix
}): string {
	const { locationPath, target, prefix } = opts
	if (!locationPath) return ''
	const parsed = parseWorkbenchHref(locationPath)
	if (!parsed || parsed.frame !== getWorkbenchFrame(prefix)) {
		return ''
	}
	if (workbenchNodeKey(parsed.target) !== workbenchNodeKey(target)) return ''
	return parsed.path
}

export function WorkbenchRouteScreen({ prefix }: { prefix: WorkbenchRoutePrefix }) {
	const { pluginName: rawName, path: rawRest } = useParams({ strict: false })
	const locationPath = useCurrentPathname()
	const target = useMemo(() => decodeWorkbenchNodeSegment(rawName), [rawName])

	const restPathFromParams = normalizeWorkbenchRestPath(rawRest)
	const restPathFromLocation = useMemo(() => {
		return readRestPathFromLocation({ locationPath, target, prefix })
	}, [locationPath, prefix, target])
	// The location keeps percent-encoded segment boundaries intact. Route params may
	// already be decoded by the router, so only use them as a fallback.
	const restPath = restPathFromLocation || restPathFromParams
	const displayPath = buildWorkbenchHref(target, restPath, getWorkbenchFrame(prefix))
	const ctxPathname =
		locationPath && locationPath.startsWith(`${prefix}/`) ? locationPath : displayPath

	return (
		<WorkbenchTargetProvider target={target} pathname={ctxPathname}>
			<ResolvedRoute
				displayPath={displayPath}
				pathname={ctxPathname}
				target={target}
				restPath={restPath}
			/>
		</WorkbenchTargetProvider>
	)
}

function ResolvedRoute({
	target,
	displayPath,
	pathname,
	restPath,
}: {
	target: PluginNodeAddressSnapshot
	displayPath: string
	pathname: string
	restPath: string
}) {
	const { route, snapshot } = useResolvedWorkbenchRoute(target, restPath)
	const displayName = snapshot.layout?.target?.displayName ?? target.definition.exportName
	return (
		<WorkbenchRouteRenderer
			target={target}
			displayName={displayName}
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
