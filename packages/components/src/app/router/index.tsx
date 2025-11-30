import React, { lazy } from 'react'
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
import { RouteSuspense } from '../routes/RouteSuspense'
import { LiveLog } from '../log_viewer/LiveLog'

const PackagesRoute = lazy(async () => ({
	default: (await import('../routes/PackagesRoute')).PackagesRoute,
}))

const MarketRoute = lazy(async () => ({
	default: (await import('../routes/MarketRoute')).MarketRoute,
}))

const PluginsRoute = lazy(async () => ({
	default: (await import('../routes/PluginsRoute')).PluginsRoute,
}))

const PluginsPlaceholder = lazy(async () => ({
	default: (await import('../routes/PluginsRoute')).PluginsPlaceholder,
}))

const PluginDetailRoute = lazy(async () => ({
	default: (await import('../routes/PluginDetailRoute')).PluginDetailRoute,
}))

const ExtensionRoute = lazy(async () => ({
	default: (await import('../routes/ExtensionRoute')).ExtensionRoute,
}))

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
	component: () => (
		<RouteSuspense label="正在加载包管理…">
			<PackagesRoute />
		</RouteSuspense>
	),
})

const marketRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: 'market',
	component: () => (
		<RouteSuspense label="正在加载市场…">
			<MarketRoute />
		</RouteSuspense>
	),
})

const pluginsRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: 'plugins',
	component: () => (
		<RouteSuspense label="正在加载插件列表…">
			<PluginsRoute />
		</RouteSuspense>
	),
})

const pluginsIndexRoute = createRoute({
	getParentRoute: () => pluginsRoute,
	path: '/',
	component: () => (
		<RouteSuspense>
			<PluginsPlaceholder />
		</RouteSuspense>
	),
})

const pluginDetailRoute = createRoute({
	getParentRoute: () => pluginsRoute,
	path: '$name',
	component: () => (
		<RouteSuspense label="正在加载插件详情…">
			<PluginDetailRoute />
		</RouteSuspense>
	),
})

const extensionRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: 'ext/$pluginName/$path*',
	component: () => (
		<RouteSuspense label="正在加载扩展页面…">
			<ExtensionRoute />
		</RouteSuspense>
	),
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
