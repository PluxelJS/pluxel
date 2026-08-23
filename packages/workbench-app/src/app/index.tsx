import { localStorageColorSchemeManager, MantineProvider } from '@mantine/core'
import { type RouterHistory, RouterProvider } from '@tanstack/react-router'
import { useState } from 'react'
import {
	getRuntimeManagementClient,
	getRuntimeTransportClient,
	RuntimeManagementClientProvider,
	RuntimeTransportClientProvider,
} from '../runtime'
import './bootstrap'
import '../styles/index.scss'
import { appCssVariablesResolver, useAppTheme } from '../theme'
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
	const [managementClient] = useState(() => getRuntimeManagementClient())
	const [workspace] = useState(() => new WorkspaceController(router.state.location.pathname))
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
				<RuntimeManagementClientProvider client={managementClient}>
					<ProductProvider client={managementClient}>
						<WorkspaceControllerProvider controller={workspace}>
							<RouterProvider router={router} />
						</WorkspaceControllerProvider>
					</ProductProvider>
				</RuntimeManagementClientProvider>
			</RuntimeTransportClientProvider>
		</MantineProvider>
	)
}

const colorSchemeManager = localStorageColorSchemeManager({
	key: 'pluxel-color-scheme',
})
