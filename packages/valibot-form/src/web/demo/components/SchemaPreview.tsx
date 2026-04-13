import { Button, Group, Paper, Stack } from '@mantine/core'
import { useClipboard } from '@mantine/hooks'
import { useMemo } from 'react'

export interface SchemaPreviewProps {
	sourceText?: string
}

export function SchemaPreview({ sourceText }: SchemaPreviewProps) {
	const text = useMemo(() => sourceText ?? '', [sourceText])
	const clipboard = useClipboard({ timeout: 1200 })

	return (
		<Stack gap="xs">
			<Group justify="flex-end" align="center">
				<Button
					variant={clipboard.copied ? 'filled' : 'light'}
					size="xs"
					onClick={() => clipboard.copy(text)}
					disabled={!text}
					type="button"
				>
					{clipboard.copied ? '已复制' : '复制源码'}
				</Button>
			</Group>
			<Paper
				component="pre"
				withBorder
				radius="sm"
				p="md"
				style={{
					fontSize: 12,
					margin: 0,
					whiteSpace: 'pre-wrap',
				}}
			>
				<code>{text || '暂无源码'}</code>
			</Paper>
		</Stack>
	)
}
