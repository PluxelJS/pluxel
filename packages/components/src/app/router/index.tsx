import {
	createBrowserHistory,
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	type RouterHistory,
} from '@tanstack/react-router'
import { RootShell } from '../layout/RootShell'
import { HomeRoute } from '../routes/HomeRoute'
import { LiveLog } from '../log_viewer/LiveLog'
import { PackagesRoute } from '../routes/PackagesRoute'
import { MarketRoute } from '../routes/MarketRoute'
import { PluginsRoute, PluginsPlaceholder } from '../routes/PluginsRoute'
import { PluginDetailRoute } from '../routes/PluginDetailRoute'
import { ExtensionRoute } from '../routes/ExtensionRoute'

const rootRoute = createRootRoute({
	component: RootShell,
})

const homeRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/',
	component: HomeRoute,
})

const logsRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: 'logs',
	component: () => <LiveLog />,
})

const packagesRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: 'packages',
	component: PackagesRoute,
})

const marketRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: 'market',
	component: MarketRoute,
})

const pluginsRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: 'plugins',
	component: PluginsRoute,
})

const pluginsIndexRoute = createRoute({
	getParentRoute: () => pluginsRoute,
	path: '/',
	component: PluginsPlaceholder,
})

const pluginDetailRoute = createRoute({
	getParentRoute: () => pluginsRoute,
	path: '$name',
	component: PluginDetailRoute,
})

const extensionRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: 'ext/$pluginName/$path*',
	component: ExtensionRoute,
})

const routeTree = rootRoute.addChildren([
	homeRoute,
	logsRoute,
	packagesRoute,
	marketRoute,
	extensionRoute,
	pluginsRoute.addChildren([pluginsIndexRoute, pluginDetailRoute]),
])

export interface CreateRouterOptions {
	history?: RouterHistory
}

export function createAppRouter(options: CreateRouterOptions = {}) {
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
