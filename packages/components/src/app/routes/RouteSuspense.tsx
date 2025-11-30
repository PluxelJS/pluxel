import { Center, Loader, Stack, Text } from '@mantine/core'
import { Suspense, type ReactNode } from 'react'

export interface RouteSuspenseProps {
	label?: string
	children: ReactNode
}

export function RouteSuspense({ label = '正在加载页面…', children }: RouteSuspenseProps) {
	return (
		<Suspense
			fallback={
				<Center style={{ flex: 1, width: '100%' }}>
					<Stack gap="xs" align="center">
						<Loader size="sm" />
						<Text c="dimmed" size="sm">
							{label}
						</Text>
					</Stack>
				</Center>
			}
		>
			{children}
		</Suspense>
	)
}
