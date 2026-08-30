import { localStorageColorSchemeManager, MantineProvider } from '@mantine/core'
import { type RouterHistory, RouterProvider } from '@tanstack/react-router'
import { useState } from 'react'
import {
	createRuntimeManagementClient,
	type RuntimeClientBootstrap,
	RuntimeManagementClientProvider,
} from '../runtime'
import './bootstrap'
import '../styles/index.scss'
import { appCssVariablesResolver, useAppTheme } from '../theme'
import { ProductProvider } from './product'
import { createAppRouter } from './router'
import { WorkspaceControllerProvider } from './workbench/context'
import { WorkspaceController } from './workbench/store'
import { WorkbenchSessionProvider } from '../workbench/runtime'

export interface AppProps {
	bootstrap: Extract<RuntimeClientBootstrap, { kind: 'workbench' }>
	history?: RouterHistory
}

export function App({ bootstrap, history }: AppProps) {
	const [router] = useState(() => createAppRouter({ history }))
	const [managementClient] = useState(() => createRuntimeManagementClient(bootstrap.management))
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
			<RuntimeManagementClientProvider client={managementClient}>
				<WorkbenchSessionProvider session={bootstrap.workbench}>
					<ProductProvider client={managementClient}>
						<WorkspaceControllerProvider controller={workspace}>
							<RouterProvider router={router} />
						</WorkspaceControllerProvider>
					</ProductProvider>
				</WorkbenchSessionProvider>
			</RuntimeManagementClientProvider>
		</MantineProvider>
	)
}

const colorSchemeManager = localStorageColorSchemeManager({
	key: 'pluxel-color-scheme',
})
