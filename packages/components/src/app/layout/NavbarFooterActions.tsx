import { ActionIcon, Button, Stack, Tooltip } from '@mantine/core'
import { IconLogout } from '@tabler/icons-react'
import { useCallback, useRef } from 'react'
import { ExtensionPoints, ExtensionSlot } from '../../extension'
import { useRuntimeTransportClient } from '../../runtime'

export function NavbarFooterActions({ compact }: { compact: boolean }) {
	const client = useRuntimeTransportClient()
	const redirectPathRef = useRef<string | null>(null)

	const gotoLogin = useCallback(() => {
		if (typeof window === 'undefined') return
		const cached = redirectPathRef.current
		if (cached) {
			window.location.assign(cached)
			return
		}
		void (async () => {
			try {
				const data = await client.http.meta.auth()
				if (data.enabled !== true) return
				const redirectPath = typeof data.redirectPath === 'string' ? data.redirectPath : ''
				if (!redirectPath) return
				redirectPathRef.current = redirectPath
				window.location.assign(redirectPath)
			} catch {
				// ignore
			}
		})()
	}, [client.http.meta])

	return (
		<Stack gap={6}>
			{compact ? null : <ExtensionSlot point={ExtensionPoints.NavbarAuthText} />}

			{compact ? (
				<Tooltip label="退出登录" position="right" openDelay={300}>
					<ActionIcon
						variant="light"
						size="lg"
						radius="xl"
						aria-label="退出登录"
						onClick={gotoLogin}
					>
						<IconLogout size={18} stroke={1.8} />
					</ActionIcon>
				</Tooltip>
			) : (
				<Button
					variant="light"
					fullWidth
					leftSection={<IconLogout size={16} />}
					onClick={gotoLogin}
				>
					退出登录
				</Button>
			)}
		</Stack>
	)
}
