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
	uiBasePath?: string
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
		basepath: options.uiBasePath ?? readWorkbenchUiBasePath(),
		defaultPreload: enableIntentPreload ? 'intent' : false,
		defaultNotFoundComponent: NotFoundScreen,
		defaultErrorComponent: RouteErrorScreen,
	} as never)
}

function readWorkbenchUiBasePath(): string {
	if (typeof document === 'undefined') return '/'
	return (
		document.querySelector('meta[name="pluxel-workbench-ui-base-path"]')?.getAttribute('content') ||
		'/'
	)
}

declare module '@tanstack/react-router' {
	interface Register {
		router: ReturnType<typeof createAppRouter>
	}
}
