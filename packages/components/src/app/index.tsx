import { localStorageColorSchemeManager, MantineProvider } from '@mantine/core'
import { type RouterHistory, RouterProvider } from '@tanstack/react-router'
import { useState } from 'react'
import { getRuntimeTransportClient, RuntimeTransportClientProvider } from '../runtime'
import './bootstrap'
import { appCssVariablesResolver, useAppTheme } from '../theme'
import { createAppRouter } from './router'

export interface AppProps {
	history?: RouterHistory
}

export function App({ history }: AppProps = {}) {
	const [router] = useState(() => createAppRouter({ history }))
	const [transportClient] = useState(() => getRuntimeTransportClient())
	const { theme } = useAppTheme()
	return (
		<MantineProvider
			theme={theme}
			colorSchemeManager={colorSchemeManager}
			defaultColorScheme="auto"
			withCssVariables
			cssVariablesResolver={appCssVariablesResolver}
		>
			<RuntimeTransportClientProvider client={transportClient}>
				<RouterProvider router={router} />
			</RuntimeTransportClientProvider>
		</MantineProvider>
	)
}

const colorSchemeManager = localStorageColorSchemeManager({
	key: 'pluxel-color-scheme',
})
