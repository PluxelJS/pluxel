import { Badge, Box, Group, Text, Tooltip } from '@mantine/core'
import { useMemo, type ElementType, type ReactNode } from 'react'
import { usePluginDependencies } from '../context'

export interface DependencyListProps {
	LinkComponent?: ElementType<{
		to: string
		children: ReactNode
	}>
}

export function usePluginDependencyEntries() {
	const contextDeps = usePluginDependencies()
	return useMemo(() => {
		const map = new Map<string, { id: string; name: string; isRunning?: boolean }>()
		for (const dep of contextDeps ?? []) {
			const name = dep.name?.trim()
			const id = dep.id?.trim()
			if (!id || !name || map.has(id)) continue
			map.set(id, { id, name, isRunning: dep.isRunning ?? undefined })
		}
		return [...map.values()]
	}, [contextDeps])
}

export function DependencyList({ LinkComponent }: DependencyListProps) {
	const entries = usePluginDependencyEntries()

	if (entries.length === 0) {
		return (
			<Text size="sm" c="dimmed">
				暂无依赖项
			</Text>
		)
	}

	return (
		<Group gap={8} wrap="wrap" align="center">
			{entries.map((dep) => {
				const color = dep.isRunning ? 'green' : 'yellow'
				const dot = (
					<Box
						component="span"
						style={{
							width: 6,
							height: 6,
							borderRadius: '50%',
							background: `var(--mantine-color-${color}-6)`,
						}}
					/>
				)

				const linkTarget = LinkComponent ? dep.id : undefined
				if (!LinkComponent || !linkTarget) {
					return (
						<Tooltip key={dep.id} label={undefined} withArrow disabled={!LinkComponent}>
							<Badge
								variant="light"
								color={color}
								leftSection={dot}
								radius="sm"
								size="sm"
								style={{ textTransform: 'none' }}
							>
								{dep.name}
							</Badge>
						</Tooltip>
					)
				}
				return (
					<Badge
						key={dep.id}
						variant="light"
						color={color}
						component={LinkComponent as any}
						to={`/plugins/${encodeURIComponent(linkTarget)}`}
						leftSection={dot}
						radius="sm"
						size="sm"
						style={{ textDecoration: 'none', textTransform: 'none' }}
					>
						{dep.name}
					</Badge>
				)
			})}
		</Group>
	)
}
