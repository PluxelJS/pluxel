import { localStorageColorSchemeManager, MantineProvider } from '@mantine/core'
import { type RouterHistory, RouterProvider } from '@tanstack/react-router'
import { useState } from 'react'
import { getRuntimeTransportClient, RuntimeTransportClientProvider } from '../runtime'
import './bootstrap'
import '../styles/index.scss'
import { appCssVariablesResolver, useAppTheme } from '../theme'
import { PluxelGQLensProvider } from './gqlens'
import { ProductProvider } from './product'
import { createAppRouter } from './router'
import { WorkspaceControllerProvider } from './workbench/context'
import { WorkspaceController } from './workbench/store'

export interface AppProps {
	history?: RouterHistory
}

export function App({ history }: AppProps = {}) {
	const [router] = useState(() => createAppRouter({ history }))
	const [transportClient] = useState(() => getRuntimeTransportClient())
	const [workspace] = useState(() => new WorkspaceController())
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
				<ProductProvider transport={transportClient}>
					<PluxelGQLensProvider>
						<WorkspaceControllerProvider controller={workspace}>
							<RouterProvider router={router} />
						</WorkspaceControllerProvider>
					</PluxelGQLensProvider>
				</ProductProvider>
			</RuntimeTransportClientProvider>
		</MantineProvider>
	)
}

const colorSchemeManager = localStorageColorSchemeManager({
	key: 'pluxel-color-scheme',
})
