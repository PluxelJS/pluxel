import { Code, Stack, Text } from '@mantine/core'
import { Link, useRouter } from '@tanstack/react-router'
import type { WorkbenchRouteDirectory } from '../../../workbench/route-directory'
import { buildWorkbenchHref } from '../../../workbench/paths'

export function WorkbenchRouteConflictList({
	routes,
	pathname,
}: {
	routes: WorkbenchRouteDirectory['routes']
	pathname?: string
}) {
	const basepath = useRouter().options.basepath ?? '/'
	return (
		<Stack gap="sm">
			{routes.map((route) => {
				const placement = route.entry.placement
				if (placement.kind !== 'route') return null
				const href = pathname
					? buildWorkbenchHref(route.entry.target.node, pathname, placement.frame)
					: route.canonicalHref
				const displayHref = `${basepath === '/' ? '' : basepath.replace(/\/$/, '')}${href}`
				const concrete =
					pathname !== undefined || route.compiled.segments.every((segment) => !segment.parameter)
				return (
					<Stack key={route.canonicalHref} gap={4} style={{ overflowWrap: 'anywhere' }}>
						<Text size="sm" fw={600}>
							{route.entry.target.displayName} · {placement.title}
						</Text>
						<Text size="xs" c="dimmed">
							{placement.path} ·{' '}
							{route.conflict?.reason === 'reserved'
								? '与工作台保留路径重叠'
								: '与其他插件的路径重叠'}
						</Text>
						{concrete ? (
							<Link to={href}>{displayHref}</Link>
						) : (
							<Code style={{ whiteSpace: 'normal', overflowWrap: 'anywhere' }}>{displayHref}</Code>
						)}
					</Stack>
				)
			})}
		</Stack>
	)
}
