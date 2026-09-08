import { Button, Code, Popover, Stack, Text } from '@mantine/core'
import { IconAlertTriangle } from '@tabler/icons-react'
import { Link, useRouter } from '@tanstack/react-router'
import type { WorkbenchRouteDirectory } from '../../../workbench/route-directory'
import { buildWorkbenchHref } from '../../../workbench/paths'
import { useWorkbenchRouteDirectory } from '../../../workbench/runtime'

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

export function WorkbenchRouteConflicts() {
	const directory = useWorkbenchRouteDirectory()
	if (directory.conflicts.length === 0) return null
	return (
		<Popover width={420} position="bottom-end" withArrow shadow="md">
			<Popover.Target>
				<Button
					variant="subtle"
					color="orange"
					size="compact-xs"
					leftSection={<IconAlertTriangle size={15} />}
				>
					路由冲突 {directory.conflicts.length}
				</Button>
			</Popover.Target>
			<Popover.Dropdown
				style={{ maxWidth: 'calc(100vw - 24px)', maxHeight: '70vh', overflowY: 'auto' }}
			>
				<Stack gap="sm">
					<Text fw={600} size="sm">
						以下页面使用完整路径
					</Text>
					<Text size="sm" c="dimmed">
						修改插件声明的路径即可消除冲突。完整链接始终可用。
					</Text>
					<WorkbenchRouteConflictList routes={directory.conflicts} />
				</Stack>
			</Popover.Dropdown>
		</Popover>
	)
}
