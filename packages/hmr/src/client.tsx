// client.tsx
import React from 'react'
import { createRoot, hydrateRoot } from 'react-dom/client'
import { Router } from 'wouter'

import { MantineProvider } from '@mantine/core'
import '@mantine/core/styles.css'
import App from './services/hono/app/app'

const root = document.getElementById('root')!

if (root.hasChildNodes()) {
	hydrateRoot(
		root,
		<Router>
			<MantineProvider withGlobalClasses={false} withCssVariables={false}>
				<App />
			</MantineProvider>
		</Router>,
	)
} else {
	createRoot(root).render(
		<Router>
			<MantineProvider withGlobalClasses={false} withCssVariables={false}>
				<App />
			</MantineProvider>
		</Router>,
	)
}
