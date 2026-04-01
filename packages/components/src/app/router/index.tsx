import {
	createBrowserHistory,
	createMemoryHistory,
	createRouter,
	type RouterHistory,
} from '@tanstack/react-router'
import { NotFoundScreen } from './screens/NotFoundScreen'
import { RouteErrorScreen } from './screens/RouteErrorScreen'
import { routeTree } from './routeTree.gen'

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
		defaultNotFoundComponent: NotFoundScreen,
		defaultErrorComponent: RouteErrorScreen,
	} as never)
}

const _routerForTypes = createAppRouter()

declare module '@tanstack/react-router' {
	interface Register {
		router: typeof _routerForTypes
	}
}
