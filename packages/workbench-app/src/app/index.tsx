import { type RouterHistory, RouterProvider } from '@tanstack/react-router'
import { useState } from 'react'
import {
	createRuntimeManagementClient,
	type RuntimeClientBootstrap,
	RuntimeManagementClientProvider,
} from '../runtime'
import './bootstrap'
import '../styles/index.scss'
import { ProductProvider } from './product'
import { createAppRouter } from './router'
import { WorkspaceControllerProvider } from './workbench/context'
import { WorkspaceController } from './workbench/store'
import { WorkbenchSessionProvider } from '../workbench/runtime'
import { ManagementQueryProvider } from './managementQuery'

export interface AppProps {
	bootstrap: Extract<RuntimeClientBootstrap, { kind: 'workbench' }>
	history?: RouterHistory
}

export function App({ bootstrap, history }: AppProps) {
	const [router] = useState(() => createAppRouter({ history }))
	const [managementClient] = useState(() => createRuntimeManagementClient(bootstrap.management))
	const [workspace] = useState(() => new WorkspaceController(router.state.location.pathname))
	return (
		<RuntimeManagementClientProvider client={managementClient}>
			<ManagementQueryProvider>
				<WorkbenchSessionProvider session={bootstrap.workbench}>
					<ProductProvider client={managementClient}>
						<WorkspaceControllerProvider controller={workspace}>
							<RouterProvider router={router} />
						</WorkspaceControllerProvider>
					</ProductProvider>
				</WorkbenchSessionProvider>
			</ManagementQueryProvider>
		</RuntimeManagementClientProvider>
	)
}
