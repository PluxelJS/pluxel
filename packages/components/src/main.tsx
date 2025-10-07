import { ColorSchemeScript, MantineProvider } from '@mantine/core'
import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './app/index.tsx'
import { theme } from './theme'
import '@mantine/core/styles.css'

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
	<React.StrictMode>
		<ColorSchemeScript defaultColorScheme="auto" />
		<MantineProvider defaultColorScheme="auto" theme={theme}>
			<App />
		</MantineProvider>
	</React.StrictMode>,
)
