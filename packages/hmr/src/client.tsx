import { App, useHydrateCache } from '@pluxel/components'
import { createRoot, hydrateRoot } from 'react-dom/client'
import { Router } from 'wouter'
import '@mantine/core/styles.css'
import '@mantine/notifications/styles.css'

const root = document.getElementById('root')!

const rawCache =
	/* (document.getElementById('__GQTY_CACHE__') as HTMLScriptElement | null)?.textContent ||  */ undefined
let cacheSnapshot: unknown
if (rawCache) {
	try {
		cacheSnapshot = JSON.parse(rawCache)
	} catch {
		cacheSnapshot = rawCache
	}
}

function Root({ snapshot }: { snapshot?: any }) {
	useHydrateCache({ cacheSnapshot: snapshot, shouldRefetch: false })

	return (
		<Router>
			<App />
		</Router>
	)
}

const element = <Root snapshot={cacheSnapshot} />

if (root.hasChildNodes()) {
	hydrateRoot(root, element)
} else {
	createRoot(root).render(element)
}
