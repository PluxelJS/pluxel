import { Anchor, Card, Group, Text, Tooltip } from '@mantine/core'
import { IconArrowRight } from '@tabler/icons-react'
import type React from 'react'
import { useMemo } from 'react'
import { usePluginDependencies } from '../context'
import type { PluginDependencySnapshot } from '../context'

export interface DependencyListProps {
	items?: readonly PluginDependencySnapshot[] | null
	LinkComponent?: React.ElementType<{ to: string; children: React.ReactNode }>
	title?: string
}

const EMPTY_LIST: readonly PluginDependencySnapshot[] = Object.freeze([])

export function DependencyList({
	items,
	LinkComponent,
	title = 'Dependencies',
}: DependencyListProps) {
	const contextDeps = usePluginDependencies()

	const entries = useMemo(() => {
		const source = items ?? contextDeps
		return source?.length ? source : EMPTY_LIST
	}, [contextDeps, items])

	if (!entries.length) {
		return (
			<Text color="dimmed" size="sm">
				暂无依赖项
			</Text>
		)
	}

	return (
		<Card shadow="xs" radius="md" p="xs">
			{title && (
				<Text w={600} size="sm" mb="xs">
					{title}
				</Text>
			)}
			<Group gap={4}>
				{entries.map((dep, idx) => {
					const componentProps = LinkComponent
						? { component: LinkComponent as any, to: dep.name }
						: { href: dep.name }

					return (
						<Tooltip
							key={dep.name || idx}
							label={dep.optional ? '可选依赖' : ''}
							position="bottom"
							withArrow
							disabled={!dep.optional}
						>
							<Anchor
								{...componentProps}
								style={(theme) => ({
									display: 'flex',
									alignItems: 'center',
									padding: '4px 8px',
								backgroundColor: dep.optional ? theme.colors.yellow[1] : theme.colors.gray[1],
								borderRadius: theme.radius.sm,
								textDecoration: 'none',
								fontSize: theme.fontSizes.xs,
								fontWeight: dep.optional ? 600 : 500,
								color: dep.optional ? theme.colors.yellow[9] : theme.colors.blue[7],
								'&:hover': {
									backgroundColor: dep.optional ? theme.colors.yellow[2] : theme.colors.gray[2],
								},
							})}
						>
								<Text span mr={4}>
									{dep.name}
								</Text>
								<IconArrowRight size={12} />
							</Anchor>
						</Tooltip>
					)
					})}
			</Group>
		</Card>
	)
}
