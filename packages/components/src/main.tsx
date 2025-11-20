import { ColorSchemeScript } from '@mantine/core'
import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './app/index.tsx'
import '@mantine/core/styles.css'
import '@mantine/notifications/styles.css'

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
	<React.StrictMode>
		<ColorSchemeScript defaultColorScheme="auto" />
		<App />
	</React.StrictMode>,
)
