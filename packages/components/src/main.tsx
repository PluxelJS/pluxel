import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './TestApp.tsx'
import Example from './components/Dashboard/Example.tsx'
import { theme } from './theme'
import { ColorSchemeScript, MantineProvider } from '@mantine/core'
import '@mantine/core/styles.css'

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
	<React.StrictMode>
		<ColorSchemeScript defaultColorScheme="auto" />
		<MantineProvider defaultColorScheme="auto" theme={theme}>
			<Example />
		</MantineProvider>
	</React.StrictMode>,
)
