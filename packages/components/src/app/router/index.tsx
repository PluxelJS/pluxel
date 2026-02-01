import {
	createBrowserHistory,
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	type RouterHistory,
} from '@tanstack/react-router'
import { AppErrorBoundary } from '../AppErrorBoundary'
import { AppProviders } from '../layout/AppProviders'
import { RootShell } from '../layout/RootShell'
import { StandaloneShell } from '../layout/StandaloneShell'
import { LiveLog } from '../log_viewer/LiveLog'
import { ExtensionRoute } from '../routes/ExtensionRoute'
import { ExtensionStandaloneRoute } from '../routes/ExtensionStandaloneRoute'
import { HomeRoute } from '../routes/HomeRoute'
import { NotFoundRoute } from '../routes/NotFoundRoute'
import { PackagesRoute } from '../routes/PackagesRoute'
import { PluginDetailRoute } from '../routes/PluginDetailRoute'
import { PluginsPlaceholder, PluginsRoute } from '../routes/PluginsRoute'
import { RouteError } from '../routes/RouteError'

const rootRoute = createRootRoute({
	component: () => (
		<AppErrorBoundary>
			<AppProviders />
		</AppErrorBoundary>
	),
})

const shellRoute = createRoute({
	getParentRoute: () => rootRoute,
	id: 'shell',
	component: RootShell,
})

const standaloneRoute = createRoute({
	getParentRoute: () => rootRoute,
	id: 'standalone',
	component: StandaloneShell,
})

const homeRoute = createRoute({
	getParentRoute: () => shellRoute,
	path: '/',
	component: HomeRoute,
})

const logsRoute = createRoute({
	getParentRoute: () => shellRoute,
	path: 'logs',
	component: () => <LiveLog />,
})

const packagesRoute = createRoute({
	getParentRoute: () => shellRoute,
	path: 'packages',
	component: PackagesRoute,
})


const pluginsRoute = createRoute({
	getParentRoute: () => shellRoute,
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

const pluginDetailIndexRoute = createRoute({
	getParentRoute: () => pluginDetailRoute,
	path: '/',
	component: () => null,
})

// 支持 /plugins/:name/* 作为插件页的“子路由”，避免切换子路由时整页卸载（对动态注入 UI 更友好）
const pluginDetailPathRoute = createRoute({
	getParentRoute: () => pluginDetailRoute,
	path: '$path*',
	component: () => null,
})

const extensionRoute = createRoute({
	getParentRoute: () => shellRoute,
	path: 'ext/$pluginName/$path*',
	component: ExtensionRoute,
})

const extensionStandaloneRoute = createRoute({
	getParentRoute: () => standaloneRoute,
	path: 'ext-standalone/$pluginName/$path*',
	component: ExtensionStandaloneRoute,
})

const routeTree = rootRoute.addChildren([
	shellRoute.addChildren([
		homeRoute,
		logsRoute,
		packagesRoute,
		extensionRoute,
		pluginsRoute.addChildren([
			pluginsIndexRoute,
			pluginDetailRoute.addChildren([pluginDetailIndexRoute, pluginDetailPathRoute]),
		]),
	]),
	standaloneRoute.addChildren([extensionStandaloneRoute]),
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
		defaultNotFoundComponent: NotFoundRoute,
		defaultErrorComponent: RouteError,
	})
}

const _routerForTypes = createAppRouter()

declare module '@tanstack/react-router' {
	interface Register {
		router: typeof _routerForTypes
	}
}
