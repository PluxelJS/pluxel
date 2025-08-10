import { MantineProvider } from '@mantine/core'
import {
	HydrationBoundary,
	QueryClient,
	QueryClientProvider,
} from '@tanstack/react-query'
// src/client.tsx
import { createRoot, hydrateRoot } from 'react-dom/client'
import { Router } from 'wouter'
import '@mantine/core/styles.css'
import '@mantine/notifications/styles.css'

import { App } from './app'
import { queryClient } from './queryClient'

const root = document.getElementById('root')!

// 取出服务端注入的 cache
const dehydratedStateEl = document.getElementById('__REACT_QUERY_STATE__')
const dehydratedState = dehydratedStateEl
	? JSON.parse(dehydratedStateEl.textContent || 'null')
	: undefined

if (root.hasChildNodes()) {
	hydrateRoot(
		root,
		<QueryClientProvider client={queryClient}>
			<HydrationBoundary state={dehydratedState}>
				<MantineProvider
					withGlobalClasses={false}
					deduplicateCssVariables={false}
				>
					<Router>
						<App />
					</Router>
				</MantineProvider>
			</HydrationBoundary>
		</QueryClientProvider>,
	)
} else {
	createRoot(root).render(
		<QueryClientProvider client={queryClient}>
			<HydrationBoundary state={undefined}>
				<MantineProvider
					withGlobalClasses={false}
					deduplicateCssVariables={false}
				>
					<Router>
						<App />
					</Router>
				</MantineProvider>
			</HydrationBoundary>
		</QueryClientProvider>,
	)
}
