import { Center, MantineProvider, Text } from '@mantine/core'
import { ModalsProvider } from '@mantine/modals'
import { Notifications } from '@mantine/notifications'
import {
	createBrowserHistory,
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	Outlet,
	type RouterHistory,
	RouterProvider,
	redirect,
	useRouterState,
} from '@tanstack/react-router'
import { useState } from 'react'
import { Layout, type NavItem } from '../components'
import { ClientOnly } from './ClientOnly'
import { Header } from './Header'
import { LiveLog } from './log_viewer/LiveLog'
import { PackageManagerPage } from './packages/PackageManagerPage'
import { Plugin } from './plugins/Plugin'
import { PluginsLayout } from './plugins/PluginsLayout'
import { RouterLinkAdapter } from './RouterLinkAdapter'

const navItems: NavItem[] = [
	{ label: '首页', href: '/', exact: true },
	{ label: '日志', href: '/logs' },
	{ label: '包管理', href: '/packages' },
	{ label: '插件', href: '/plugins' },
]

function RootAppLayout() {
	const pathname = useRouterState({ select: (state) => state.location.pathname })

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
					<Outlet />
				</Layout>
			</ModalsProvider>
		</MantineProvider>
	)
}

function PluginsRouteComponent() {
	return <PluginsLayout />
}

function PackagesRouteComponent() {
	return (
		<ClientOnly>
			<PackageManagerPage />
		</ClientOnly>
	)
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

const packagesRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: 'packages',
	component: PackagesRouteComponent,
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
	packagesRoute,
	pluginsRoute.addChildren([pluginsIndexRoute, pluginDetailRoute]),
])

export interface AppProps {
	history?: RouterHistory
}

export function createAppRouter(options: { history?: RouterHistory } = {}) {
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
