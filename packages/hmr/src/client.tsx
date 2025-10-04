import { MantineProvider } from '@mantine/core'
import { createRoot, hydrateRoot } from 'react-dom/client'
import { Router } from 'wouter'
import '@mantine/core/styles.css'
import '@mantine/notifications/styles.css'

import { App } from './app'
import { useHydrateCache } from './app/gqty'

const root = document.getElementById('root')!

const cacheSnapshot = undefined

function Root({ snapshot }: { snapshot?: string }) {
	useHydrateCache({ cacheSnapshot: snapshot, shouldRefetch: false })

	return (
		<MantineProvider withGlobalClasses={false} deduplicateCssVariables={false}>
			<Router>
				<App />
			</Router>
		</MantineProvider>
	)
}

const element = <Root snapshot={cacheSnapshot} />

if (root.hasChildNodes()) {
	hydrateRoot(root, element)
} else {
	createRoot(root).render(element)
}
