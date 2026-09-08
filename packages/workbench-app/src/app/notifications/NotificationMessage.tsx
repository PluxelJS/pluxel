import { Button, CopyButton, Stack } from '@mantine/core'
import type { ReactNode } from 'react'

export function NotificationMessage({
	message,
	copyText,
}: {
	message: ReactNode
	copyText: string
}) {
	return (
		<Stack gap={6}>
			<div style={{ userSelect: 'text', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
				{message}
			</div>
			<CopyButton value={copyText}>
				{({ copied, copy }) => (
					<Button
						variant="subtle"
						size="compact-xs"
						onClick={copy}
						style={{ alignSelf: 'flex-start' }}
					>
						{copied ? '已复制' : '复制通知'}
					</Button>
				)}
			</CopyButton>
		</Stack>
	)
}
