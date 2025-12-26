import { ActionIcon, Affix, Box, Group, Paper, ScrollArea, Stack, Text } from '@mantine/core'
import { IconChevronLeft, IconChevronRight, IconListDetails } from '@tabler/icons-react'
import type React from 'react'
import { useState } from 'react'

export function FloatingToc({
	title,
	hint,
	meta,
	controls,
	onExpandedChange,
	viewportRef,
	children,
}: {
	title: string
	hint: string
	meta?: React.ReactNode
	controls?: React.ReactNode
	onExpandedChange?: (expanded: boolean) => void
	viewportRef?: (node: HTMLDivElement | null) => void
	children: React.ReactNode
}) {
	const [expanded, setExpanded] = useState(false)
	const railWidth = 44
	const panelWidth = 300
	const panelHeight = expanded ? '72vh' : 'auto'

	const updateExpanded = (next: boolean) => {
		setExpanded(next)
		onExpandedChange?.(next)
	}

	return (
		<Affix position={{ top: 86, right: 16 }} zIndex={950} withinPortal>
			<Box
				onMouseEnter={() => updateExpanded(true)}
				onMouseLeave={() => updateExpanded(false)}
				onFocus={() => updateExpanded(true)}
				onBlur={() => updateExpanded(false)}
				style={{ width: panelWidth, maxWidth: '82vw' }}
			>
				<Paper
					withBorder
					shadow="md"
					p="sm"
					radius="lg"
					style={{
						transition: 'transform 160ms ease, box-shadow 160ms ease, opacity 160ms ease',
						transform: expanded
							? 'translateX(0)'
							: `translateX(calc(100% - ${railWidth}px))`,
						maxHeight: '72vh',
						height: panelHeight,
						overflow: 'hidden',
						backgroundColor: 'var(--mantine-color-body)',
						border: '1px solid var(--mantine-color-default-border)',
						boxShadow: expanded ? 'var(--mantine-shadow-lg)' : 'var(--mantine-shadow-sm)',
					}}
				>
					<Stack gap="xs" style={{ height: expanded ? '100%' : 'auto' }}>
						<Group justify="space-between" align="center" gap="xs">
							<Group gap={8} wrap="nowrap" style={{ minWidth: 0 }}>
								<Box
									style={{
										width: railWidth - 8,
										height: railWidth - 8,
										borderRadius: 12,
										display: 'flex',
										alignItems: 'center',
										justifyContent: 'center',
										background: 'var(--mantine-color-blue-light)',
										border: '1px solid var(--mantine-color-blue-outline)',
										flexShrink: 0,
									}}
								>
									<IconListDetails size={16} color="var(--mantine-color-blue-filled)" />
								</Box>
								<Box style={{ minWidth: 0, opacity: expanded ? 1 : 0, transition: 'opacity 140ms ease' }}>
									<Text
										size="sm"
										fw={700}
										style={{
											whiteSpace: 'nowrap',
											overflow: 'hidden',
											textOverflow: 'ellipsis',
										}}
									>
										{title}
									</Text>
								</Box>
							</Group>
							<Group gap={8} wrap="nowrap">
								{expanded && meta ? <Box>{meta}</Box> : null}
								<ActionIcon
									variant="subtle"
									aria-label={expanded ? '收起目录' : '展开目录'}
									onClick={() => updateExpanded(!expanded)}
								>
									{expanded ? <IconChevronRight size={16} /> : <IconChevronLeft size={16} />}
								</ActionIcon>
							</Group>
						</Group>
						{expanded ? (
							<Text size="xs" c="dimmed">
								{hint}
							</Text>
						) : null}
						{expanded && controls ? <Box>{controls}</Box> : null}
						<ScrollArea
							style={{ flex: 1, minHeight: 0 }}
							type="auto"
							scrollbarSize={8}
							viewportRef={viewportRef}
						>
							<Box pr={4} pb={2}>
								{children}
							</Box>
						</ScrollArea>
					</Stack>
				</Paper>
			</Box>
		</Affix>
	)
}
