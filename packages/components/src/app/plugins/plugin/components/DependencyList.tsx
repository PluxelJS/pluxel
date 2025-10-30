import { Anchor, Box, Group, Stack, Text } from '@mantine/core'
import type React from 'react'
import { useMemo } from 'react'
import { usePluginDependencies } from '../context'
import type { PluginDependencySnapshot } from '../context'

export interface DependencyListProps {
	items?: readonly PluginDependencySnapshot[] | null
	LinkComponent?: React.ElementType<{ to: string; children: React.ReactNode }>
}

const EMPTY_LIST: readonly PluginDependencySnapshot[] = Object.freeze([])

export function DependencyList({
	items,
	LinkComponent,
}: DependencyListProps) {
	const contextDeps = usePluginDependencies()

	const entries = useMemo(() => {
		const source = items ?? contextDeps
		return source?.length ? source : EMPTY_LIST
	}, [contextDeps, items])

	if (!entries.length) {
		return (
			<Text size="sm" c="dimmed">
				暂无依赖项
			</Text>
		)
	}

	return (
		<Stack gap={2}>
			{entries.map((dep, idx) => {
				const key = dep.name || idx
				const palette = dep.optional ? 'yellow' : 'blue'
				if (!LinkComponent) {
					return (
						<Group key={key} gap={6} wrap="nowrap" align="center">
							<Box
								component="span"
								style={{
									width: 6,
									height: 6,
									borderRadius: '50%',
									background: `var(--mantine-color-${palette}-6)`,
								}}
							/>
							<Text span size="sm" fw={500} c={`${palette}.8`}>
								{dep.name}
							</Text>
							{dep.optional && (
								<Text span size="xs" c="yellow.8">
									(可选)
								</Text>
							)}
						</Group>
					)
				}
				return (
					<Anchor
						key={key}
						component={LinkComponent as any}
						to={dep.name}
						size="sm"
						c={`${palette}.7`}
						underline="never"
						style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
					>
						<Box
							component="span"
							style={{
								width: 6,
								height: 6,
								borderRadius: '50%',
								background: `var(--mantine-color-${palette}-6)`,
							}}
						/>
						<Text span size="sm" fw={500} c={`${palette}.8`}>
							{dep.name}
						</Text>
						{dep.optional && (
							<Text span size="xs" c="yellow.8">
								(可选)
							</Text>
						)}
					</Anchor>
				)
			})}
		</Stack>
	)
}
