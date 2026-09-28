import type { RuntimeSecurityClient } from '@pluxel/services/management/client'
import { createWorkbenchRenderer, type WorkbenchHostFacade } from '@pluxel/workbench/react'
import { VaultWorkbench } from '../workbench.ts'

export const vaultScope = createWorkbenchRenderer(VaultWorkbench.overview)
export function securityOf(host: WorkbenchHostFacade): RuntimeSecurityClient {
	if (!host.management) throw new Error('This Workbench host does not provide management access')
	return host.management.security
}
export const overviewQuery = vaultScope.query(({ host }) => ({
	queryKey: ['vault', 'overview'],
	queryFn: async () => {
		const overview = await securityOf(host).readOverview()
		return overview.vault
	},
}))
