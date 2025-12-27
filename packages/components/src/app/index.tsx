import { localStorageColorSchemeManager, MantineProvider } from '@mantine/core'
import { type RouterHistory, RouterProvider } from '@tanstack/react-router'
import { useState } from 'react'
import { HmrWebClientProvider } from './rpc'
import './bootstrap'
import { useDynamicTheme } from '../theme'
import { createAppRouter } from './router'

export interface AppProps {
	history?: RouterHistory
}

export function App({ history }: AppProps = {}) {
	const [router] = useState(() => createAppRouter({ history }))
	const { theme } = useDynamicTheme()
	return (
		<MantineProvider
			theme={theme}
			colorSchemeManager={colorSchemeManager}
			withCssVariables
		>
			<HmrWebClientProvider>
				<RouterProvider router={router} />
			</HmrWebClientProvider>
		</MantineProvider>
	)
}

const colorSchemeManager = localStorageColorSchemeManager({
	key: 'pluxel-color-scheme',
})
