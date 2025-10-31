import { Center, MantineProvider, Text } from '@mantine/core'
import { ModalsProvider } from '@mantine/modals'
import { Notifications } from '@mantine/notifications'
import { useEffect, useState } from 'react'
import { Redirect, Route, Switch, useLocation } from 'wouter'
import { Layout, type NavItem } from '../components'
import { Header } from './Header'
import { LiveLog } from './log_viewer/LiveLog'
import { PluginsLayout } from './plugins/PluginsLayout'
import { WouterLinkAdapter } from './WouterLinkAdapter'
import { client, type InferSuccessResponse } from './rpc'

const navItems: NavItem[] = [
	{ label: '首页', href: '/', exact: true },
	{ label: '日志', href: '/logs' },
	{ label: '插件', href: '/plugins' }, // 会对 /plugins/:name 前缀激活
]

export function App() {
	const [location, navigate] = useLocation()
	const guardState = useRouteGuard(location, navigate)

	return (
		<MantineProvider withGlobalClasses={false} deduplicateCssVariables={false}>
			<ModalsProvider>
				<Notifications position="top-center" />
				<Layout
					header={({ toggle }) => <Header onMenu={toggle} />}
					navItems={navItems}
					LinkComponent={WouterLinkAdapter}
					currentPath={location}
					footerHeight={0}
				>
					{guardState === 'allowed' ? (
						<Switch>
							<Route path="/" component={() => <Redirect to="/plugins" />} />

							<Route path="/logs">{() => <LiveLog />}</Route>
							<Route path="/plugins/:name">{() => <PluginsLayout />}</Route>
							<Route path="/plugins">{() => <PluginsLayout />}</Route>

							<Route>404 – 页面未找到</Route>
						</Switch>
					) : (
						<Center style={{ flex: 1, minHeight: 0 }}>
							<Text c="dimmed">
								{guardState === 'checking' ? '正在校验访问权限…' : '正在跳转至验证页面…'}
							</Text>
						</Center>
					)}
				</Layout>
			</ModalsProvider>
		</MantineProvider>
	)
}

type GuardResponse = InferSuccessResponse<(typeof client.auth.guard)['$get']>
type GuardState = 'checking' | 'allowed' | 'blocked'

function useRouteGuard(
	path: string,
	navigate: (to: string, options?: { replace?: boolean }) => void,
): GuardState {
	const [state, setState] = useState<GuardState>('checking')

	useEffect(() => {
		let cancelled = false
		const controller = new AbortController()
		setState('checking')

		const runGuard = async () => {
			try {
				const res = await client.auth.guard.$get(
					{ query: { path } },
					{ init: { signal: controller.signal } },
				)
				if (cancelled) return
				if (res.ok) {
					const data: GuardResponse = await res.json()
					if (cancelled) return
					if (data.allow) {
						setState('allowed')
						return
					}
					setState('blocked')
					const target = data.redirectPath ?? '/'
					if (target && target !== path) {
						navigate(target, { replace: true })
					}
					return
				}

				if (res.status === 403) {
					let data: GuardResponse | undefined
					try {
						data = (await res.json()) as GuardResponse
					} catch {
						data = undefined
					}
					if (cancelled) return
					setState('blocked')
					const target = data?.redirectPath ?? '/'
					if (target && target !== path) {
						navigate(target, { replace: true })
					}
					return
				}

				setState('allowed')
			} catch (error) {
				if (!cancelled) setState('allowed')
			}
		}

		void runGuard()

		return () => {
			cancelled = true
			controller.abort()
		}
	}, [navigate, path])

	return state
}
