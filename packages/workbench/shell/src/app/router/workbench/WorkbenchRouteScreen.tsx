import { Stack } from '@mantine/core'
import { useMemo } from 'react'
import {
	buildWorkbenchHref,
	getWorkbenchFrame,
	parseWorkbenchHref,
	type WorkbenchRoutePrefix,
} from '../../../workbench/paths'
import type { PluginNodeAddress } from '@pluxel/core'
import { WorkbenchTargetProvider, useResolvedWorkbenchRoute } from '../../../workbench/runtime'
import { useCurrentPathname } from '../useCurrentRoute'
import { WorkbenchRouteRenderer } from './WorkbenchRouteRenderer'

export function WorkbenchRouteScreen({
	prefix,
	pathname,
}: {
	prefix: WorkbenchRoutePrefix
	pathname?: string
}) {
	const routerPathname = useCurrentPathname()
	const locationPath = pathname ?? routerPathname
	const parsed = useMemo(() => {
		if (!locationPath) return undefined
		const result = parseWorkbenchHref(locationPath)
		return result?.frame === getWorkbenchFrame(prefix) ? result : undefined
	}, [locationPath, prefix])
	if (!parsed) throw new Error('Invalid Workbench Plugin route')
	const target = parsed.target
	const restPath = parsed.path
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
	target: PluginNodeAddress
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
