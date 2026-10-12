import {
	createBrowserHistory,
	createMemoryHistory,
	createRouter,
	type RouterHistory,
} from '@tanstack/react-router'
import type { ReactNode, ReactElement } from 'react'
import { NotFoundScreen } from './screens/NotFoundScreen'
import { RouteErrorScreen } from './screens/RouteErrorScreen'
import { routeTree } from './routeTree.gen'

export interface CreateRouterOptions {
	history?: RouterHistory
	uiBasePath?: string
	Wrap?: (props: { children: ReactNode }) => ReactElement
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
		defaultNotFoundComponent: () => <NotFoundScreen />,
		defaultErrorComponent: ({ error, reset }) => <RouteErrorScreen error={error} onRetry={reset} />,
		Wrap: options.Wrap,
	})
}

export function readWorkbenchUiBasePath(): string {
	if (typeof document === 'undefined') return '/'
	const path =
		document.querySelector('meta[name="pluxel-workbench-ui-base-path"]')?.getAttribute('content') ||
		'/'
	return path === '/' ? '/' : `/${path.split('/').filter(Boolean).join('/')}`
}

declare module '@tanstack/react-router' {
	interface Register {
		router: ReturnType<typeof createAppRouter>
	}
}
