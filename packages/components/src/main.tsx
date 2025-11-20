import { ColorSchemeScript, MantineProvider, localStorageColorSchemeManager } from '@mantine/core'
import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './app/index.tsx'
import { theme } from './theme'
import '@mantine/core/styles.css'
import '@mantine/notifications/styles.css'

const colorSchemeManager = localStorageColorSchemeManager({
	key: 'pluxel-color-scheme',
})

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
	<React.StrictMode>
		<ColorSchemeScript defaultColorScheme="auto" />
		<MantineProvider
			theme={theme}
			defaultColorScheme="auto"
			colorSchemeManager={colorSchemeManager}
			withCssVariables
		>
			<App />
		</MantineProvider>
	</React.StrictMode>,
)
