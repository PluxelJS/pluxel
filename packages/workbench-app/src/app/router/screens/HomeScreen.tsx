import { Center, Text } from '@mantine/core'
import { useNavigate, useRouterState } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { LAST_ROUTE_KEY } from '../../constants'
import { HomeIntro } from '../../home/HomeIntro'

export function HomeScreen() {
	const navigate = useNavigate()
	// 使用 useRouterState + select 精确订阅，减少不必要的重渲染
	// https://github.com/TanStack/router/issues/3110
	const isManual = useRouterState({
		select: (s) => (s.location.state as { manual?: boolean } | null)?.manual === true,
	})
	const [showIntro, setShowIntro] = useState(false)
	const [lastRoute, setLastRoute] = useState<string | null>(null)
	const hasNavigatedRef = useRef(false)

	useEffect(() => {
		if (hasNavigatedRef.current) return

		const last = localStorage.getItem(LAST_ROUTE_KEY)
		setLastRoute(last)

		if (isManual) {
			setShowIntro(true)
			return
		}

		// 非主动访问首页时，尝试恢复上次路由
		if (last && last !== '/') {
			hasNavigatedRef.current = true
			void navigate({ to: last, replace: true })
			return
		}

		setShowIntro(true)
	}, [isManual, navigate])

	if (!showIntro) {
		return (
			<Center h="100%">
				<Text c="dimmed">正在为你恢复上次的工作环境…</Text>
			</Center>
		)
	}

	return <HomeIntro lastRoute={lastRoute} />
}
