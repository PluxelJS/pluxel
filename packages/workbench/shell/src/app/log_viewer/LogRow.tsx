import { Box, Text, UnstyledButton } from '@mantine/core'
import { memo } from 'react'
import type { RuntimeLogLine } from '../../runtime'
import { useThemeModel } from '../../theme'
import {
	formatCategory,
	formatTime,
	messageToText,
	oneLine,
	renderAnsi,
	stripAnsi,
} from './logFormatting'

export const LOG_ROW_HEIGHT = 24
export interface LogRowProps {
	line: RuntimeLogLine
	preview?: boolean
	selected?: boolean
	striped?: boolean
	onSelect?: (line: RuntimeLogLine) => void
	showName?: boolean
	showCategory?: boolean
	ansi?: boolean
}
/** A shared, read-only record presentation; the containing surface owns selection. */
export const LogRow = memo(function LogRow({
	line,
	preview = false,
	selected = false,
	striped = false,
	onSelect,
	showName = false,
	showCategory = false,
	ansi = true,
}: LogRowProps) {
	const palette = useThemeModel().log
	const levelColor = palette.levels[line.level] ?? palette.levels.default
	const text = messageToText(line)
	const message = preview ? text : oneLine(text)
	const content = (
		<>
			<Box
				style={{
					display: 'flex',
					alignItems: 'center',
					gap: 'var(--mantine-spacing-xs)',
					flexShrink: 0,
					minWidth: 0,
				}}
			>
				<Text
					component="time"
					size="xs"
					c="dimmed"
					style={{ fontFamily: 'inherit', whiteSpace: 'nowrap' }}
				>
					{formatTime(line.ts)}
				</Text>
				<Text
					component="span"
					size="xs"
					fw={600}
					c={levelColor}
					style={{ width: '7ch', flexShrink: 0 }}
				>
					{line.level.toUpperCase()}
				</Text>
				{showName && line.name && (
					<Text component="span" size="xs" truncate maw={160}>
						{line.name}
					</Text>
				)}
				{showCategory && line.category?.length ? (
					<Text component="span" size="xs" c="dimmed" truncate maw={200}>
						{formatCategory(line.category)}
					</Text>
				) : null}
			</Box>
			<Text
				component="span"
				size="xs"
				lineClamp={preview ? 2 : undefined}
				style={{
					fontFamily: 'inherit',
					minWidth: 0,
					overflow: 'hidden',
					...(preview
						? { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }
						: { whiteSpace: 'nowrap', textOverflow: 'ellipsis', flex: 1 }),
				}}
			>
				{ansi ? renderAnsi(message, palette.ansi16) : stripAnsi(message)}
			</Text>
		</>
	)
	const style = {
		display: 'flex',
		flexDirection: preview ? ('column' as const) : ('row' as const),
		alignItems: preview ? 'stretch' : 'center',
		gap: preview ? 0 : 'var(--mantine-spacing-xs)',
		width: '100%',
		minWidth: 0,
		fontFamily: 'var(--mantine-font-family-monospace)',
		borderBottom: '1px solid var(--mantine-color-default-border)',
		background: selected ? palette.rowSelectedBg : striped ? palette.listStripe : undefined,
		...(preview
			? { paddingBlock: 'var(--mantine-spacing-xs)' }
			: { height: LOG_ROW_HEIGHT, paddingInline: 'var(--mantine-spacing-xs)' }),
	}
	if (preview || !onSelect) return <Box style={style}>{content}</Box>
	return (
		<UnstyledButton
			aria-pressed={selected}
			style={{ ...style, userSelect: 'text' }}
			onClick={(event) => {
				const selection = window.getSelection()
				if (
					selection &&
					!selection.isCollapsed &&
					selection.anchorNode &&
					event.currentTarget.contains(selection.anchorNode)
				)
					return
				onSelect(line)
			}}
		>
			{content}
		</UnstyledButton>
	)
})
