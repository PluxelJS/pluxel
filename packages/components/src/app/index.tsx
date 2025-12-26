import { localStorageColorSchemeManager, MantineProvider } from '@mantine/core'
import { RouterProvider, type RouterHistory } from '@tanstack/react-router'
import { useState } from 'react'
import { HmrWebClientProvider } from './rpc'
import './bootstrap'
import { createAppRouter } from './router'
import { useDynamicTheme } from '../theme'

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
			withGlobalClasses={false}
			deduplicateCssVariables={false}
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
