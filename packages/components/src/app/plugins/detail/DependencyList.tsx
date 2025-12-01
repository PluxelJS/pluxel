import { Badge, Box, Group, Text } from '@mantine/core'
import type React from 'react'
import { useMemo } from 'react'
import { usePluginDependencies } from './context'

export interface DependencyListProps {
	LinkComponent?: React.ElementType<{ to: string; children: React.ReactNode }>
}

export function usePluginDependencyEntries() {
	const contextDeps = usePluginDependencies()
	return useMemo(() => {
		const map = new Map<string, { name: string; isRunning?: boolean }>()
		for (const dep of contextDeps ?? []) {
			const name = dep.name?.trim()
			if (!name || map.has(name)) continue
			map.set(name, { name, isRunning: dep.isRunning ?? undefined })
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

				if (!LinkComponent) {
					return (
						<Badge
							key={dep.name}
							variant="light"
							color={color}
							leftSection={dot}
							radius="sm"
							size="sm"
						>
							{dep.name}
						</Badge>
					)
				}
				return (
					<Badge
						key={dep.name}
						variant="light"
						color={color}
						component={LinkComponent as any}
						to={`/plugins/${encodeURIComponent(dep.name)}`}
						leftSection={dot}
						radius="sm"
						size="sm"
						style={{ textDecoration: 'none' }}
					>
						{dep.name}
					</Badge>
				)
			})}
		</Group>
	)
}
