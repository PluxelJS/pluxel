import {
	createBrowserHistory,
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	type RouterHistory,
} from '@tanstack/react-router'
import { AppErrorBoundary } from '../AppErrorBoundary'
import { RootShell } from '../layout/RootShell'
import { LiveLog } from '../log_viewer/LiveLog'
import { ExtensionRoute } from '../routes/ExtensionRoute'
import { HomeRoute } from '../routes/HomeRoute'
import { NotFoundRoute } from '../routes/NotFoundRoute'
import { PackagesRoute } from '../routes/PackagesRoute'
import { PluginDetailRoute } from '../routes/PluginDetailRoute'
import { PluginsPlaceholder, PluginsRoute } from '../routes/PluginsRoute'
import { RouteError } from '../routes/RouteError'

const rootRoute = createRootRoute({
	component: () => (
		<AppErrorBoundary>
			<RootShell />
		</AppErrorBoundary>
	),
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
	getParentRoute: () => rootRoute,
	path: 'ext/$pluginName/$path*',
	component: ExtensionRoute,
})

const routeTree = rootRoute.addChildren([
	homeRoute,
	logsRoute,
	packagesRoute,
	extensionRoute,
	pluginsRoute.addChildren([
		pluginsIndexRoute,
		pluginDetailRoute.addChildren([pluginDetailIndexRoute, pluginDetailPathRoute]),
	]),
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
