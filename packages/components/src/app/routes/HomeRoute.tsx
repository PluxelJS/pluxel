import { Center, Text } from '@mantine/core'
import { useNavigate, useRouterState } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { HOME_MANUAL_KEY, LAST_ROUTE_KEY } from '../constants'
import { HomeIntro } from '../home/HomeIntro'

export function HomeRoute() {
	const navigate = useNavigate()
	const routerState = useRouterState({ select: (state) => state.location.pathname })
	const [showIntro, setShowIntro] = useState(false)
	const [lastRoute, setLastRoute] = useState<string | null>(null)

	useEffect(() => {
		if (typeof window === 'undefined') return
		const manual = window.sessionStorage.getItem(HOME_MANUAL_KEY)
		const last = window.localStorage.getItem(LAST_ROUTE_KEY)
		setLastRoute(last)
		if (manual) {
			window.sessionStorage.removeItem(HOME_MANUAL_KEY)
			setShowIntro(true)
			return
		}
		if (last && last !== '/' && last !== routerState) {
			navigate({ to: last as never, replace: true })
			return
		}
		setShowIntro(true)
	}, [navigate, routerState])

	if (!showIntro) {
		return (
			<Center h="100%">
				<Text c="dimmed">正在为你恢复上次的工作环境…</Text>
			</Center>
		)
	}

	return <HomeIntro lastRoute={lastRoute} />
}
