import {
	createBrowserHistory,
	createMemoryHistory,
	createRouter,
	type RouterHistory,
} from '@tanstack/react-router'
import { NotFoundRoute, RouteError } from './views'
import { routeTree } from './routeTree.gen'

export type PluginDetailSearch = {
	tab?: string
	schema?: string
}

export function validatePluginDetailSearch(search: Record<string, unknown>): PluginDetailSearch {
	return {
		tab: typeof search.tab === 'string' && search.tab.trim().length > 0 ? search.tab : undefined,
		schema:
			typeof search.schema === 'string' && search.schema.trim().length > 0
				? search.schema
				: undefined,
	}
}

export interface CreateRouterOptions {
	history?: RouterHistory
}

export function createAppRouter(options: CreateRouterOptions = {}) {
	const enableIntentPreload =
		(typeof import.meta !== 'undefined' &&
		typeof import.meta.env === 'object' &&
		import.meta.env &&
		'PROD' in import.meta.env
			? import.meta.env.PROD
			: process.env.NODE_ENV === 'production') === true
	const history =
		options.history ??
		(typeof window !== 'undefined' ? createBrowserHistory() : createMemoryHistory())
	return createRouter({
		routeTree,
		history,
		defaultPreload: enableIntentPreload ? 'intent' : false,
		defaultNotFoundComponent: NotFoundRoute,
		defaultErrorComponent: RouteError,
	} as never)
}

const _routerForTypes = createAppRouter()

declare module '@tanstack/react-router' {
	interface Register {
		router: typeof _routerForTypes
	}
}
