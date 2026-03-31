import { Button, Group, Stack } from '@mantine/core'
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
			<pre
				style={{
					fontSize: 12,
					margin: 0,
					padding: 12,
					backgroundColor: 'var(--plx-panel-bg-muted, var(--mantine-color-default-hover))',
					borderRadius: 6,
					border: '1px solid var(--plx-panel-border, var(--mantine-color-default-border))',
					whiteSpace: 'pre-wrap',
				}}
			>
				<code>{text || '暂无源码'}</code>
			</pre>
		</Stack>
	)
}
