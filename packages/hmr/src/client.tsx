import { MantineProvider } from '@mantine/core'
import {
	Hydrate,
	QueryClient,
	QueryClientProvider,
} from '@tanstack/react-query'
// src/client.tsx
import { createRoot, hydrateRoot } from 'react-dom/client'
import { Router } from 'wouter'
import '@mantine/core/styles.css'

import { App } from './app'

const root = document.getElementById('root')!
const queryClient = new QueryClient()

// 取出服务端注入的 cache
const dehydratedState = document.getElementById(
	'__REACT_QUERY_STATE__',
)?.textContent

if (root.hasChildNodes()) {
	hydrateRoot(
		root,
		<QueryClientProvider client={queryClient}>
			<Hydrate
				state={dehydratedState ? JSON.parse(dehydratedState) : undefined}
			>
				<MantineProvider withGlobalClasses={false}>
					<Router>
						<App />
					</Router>
				</MantineProvider>
			</Hydrate>
		</QueryClientProvider>,
	)
} else {
	createRoot(root).render(
		<QueryClientProvider client={queryClient}>
			<Hydrate state={undefined}>
				<MantineProvider withGlobalClasses={false}>
					<Router>
						<App />
					</Router>
				</MantineProvider>
			</Hydrate>
		</QueryClientProvider>,
	)
}
