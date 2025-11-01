import { Center, MantineProvider, Text } from '@mantine/core'
import { ModalsProvider } from '@mantine/modals'
import { Notifications } from '@mantine/notifications'
import { useCallback, useEffect, useState } from 'react'
import {
	Outlet,
	RouterProvider,
	createBrowserHistory,
	createMemoryHistory,
	createRoute,
	createRouter,
	createRootRoute,
	redirect,
	useNavigate,
	useRouterState,
	type AnyHistory,
} from '@tanstack/react-router'
import { Layout, type NavItem } from '../components'
import { Header } from './Header'
import { ClientOnly } from './ClientOnly'
import { LiveLog } from './log_viewer/LiveLog'
import { Plugin } from './plugins/Plugin'
import { PluginsLayout } from './plugins/PluginsLayout'
import { RouterLinkAdapter } from './RouterLinkAdapter'
import { authClient, type InferSuccessResponse } from './rpc'

const navItems: NavItem[] = [
	{ label: '首页', href: '/', exact: true },
	{ label: '日志', href: '/logs' },
	{ label: '插件', href: '/plugins' },
]

function RootAppLayout() {
	const pathname = useRouterState({ select: (state) => state.location.pathname })
	const routerNavigate = useNavigate()

	const navigate = useCallback(
		(to: string, options?: { replace?: boolean }) =>
			routerNavigate({ to, replace: options?.replace ?? false }),
		[routerNavigate],
	)

	const guardState = useRouteGuard(pathname, navigate)

	return (
		<MantineProvider withGlobalClasses={false} deduplicateCssVariables={false}>
			<ModalsProvider>
				<Notifications position="top-center" />
				<Layout
					header={({ toggle }) => <Header onMenu={toggle} />}
					navItems={navItems}
					LinkComponent={RouterLinkAdapter}
					currentPath={pathname}
					footerHeight={0}
				>
					{guardState === 'allowed' ? (
						<Outlet />
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

function PluginsRouteComponent() {
	return <PluginsLayout />
}

function PluginsPlaceholder() {
	return (
		<Center style={{ flex: 1 }}>
			<Text c="dimmed" size="lg">
				请选择一个插件以查看详情
			</Text>
		</Center>
	)
}

function PluginDetailRouteComponent() {
	const { name: rawName } = pluginDetailRoute.useParams()
	let name = rawName
	try {
		name = decodeURIComponent(rawName)
	} catch {
		// ignore decode failure, fallback to raw string
	}
	return (
		<ClientOnly>
			<Plugin pluginName={name} />
		</ClientOnly>
	)
}

const rootRoute = createRootRoute({
	component: RootAppLayout,
})

const indexRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/',
	beforeLoad: () => {
		throw redirect({ to: '/plugins', replace: true })
	},
})

const logsRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: 'logs',
	component: () => <LiveLog />,
})

const pluginsRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: 'plugins',
	component: PluginsRouteComponent,
})

const pluginsIndexRoute = createRoute({
	getParentRoute: () => pluginsRoute,
	path: '/',
	component: PluginsPlaceholder,
})

const pluginDetailRoute = createRoute({
	getParentRoute: () => pluginsRoute,
	path: '$name',
	component: PluginDetailRouteComponent,
})

const routeTree = rootRoute.addChildren([
	indexRoute,
	logsRoute,
	pluginsRoute.addChildren([pluginsIndexRoute, pluginDetailRoute]),
])

export interface AppProps {
	history?: AnyHistory
}

export function createAppRouter(options: { history?: AnyHistory } = {}) {
	const history =
		options.history ??
		(typeof window !== 'undefined' ? createBrowserHistory() : createMemoryHistory())
	return createRouter({
		routeTree,
		history,
		defaultPreload: 'intent',
	})
}

const _routerForTypes = createAppRouter()

declare module '@tanstack/react-router' {
	interface Register {
		router: typeof _routerForTypes
	}
}

export function App({ history }: AppProps = {}) {
	const [router] = useState(() => createAppRouter({ history }))
	return <RouterProvider router={router} />
}

type GuardResponse = InferSuccessResponse<(typeof authClient.guard)['$get']>
type GuardState = 'checking' | 'allowed' | 'blocked'

function useRouteGuard(
	path: string,
	navigate: (to: string, options?: { replace?: boolean }) => void,
): GuardState {
	const [state, setState] = useState<GuardState>('checking')

	useEffect(() => {
		let cancelled = false
		const controller = new AbortController()
		setState((prev) => (prev === 'allowed' ? 'allowed' : 'checking'))

		const runGuard = async () => {
			try {
				const res = await authClient.guard.$get(
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
