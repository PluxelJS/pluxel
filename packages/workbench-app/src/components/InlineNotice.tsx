import { Alert, Text } from '@mantine/core'
import type { ReactNode } from 'react'

export interface InlineNoticeProps {
	title: ReactNode
	children?: ReactNode
	tone?: 'error' | 'muted'
}

export function InlineNotice({ title, children, tone = 'muted' }: InlineNoticeProps) {
	return (
		<Alert
			variant="light"
			color={tone === 'error' ? 'red' : 'gray'}
			radius="md"
			icon={null}
			title={title}
		>
			{typeof children === 'string' ? <Text size="sm">{children}</Text> : children}
		</Alert>
	)
}
