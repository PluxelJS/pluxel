import type { RpcTarget } from 'capnweb'
import { workbench } from '@pluxel/workbench'

export const VaultWorkbench = workbench.define({
	overview: workbench.view<RpcTarget>({
		renderer: workbench.entry(import.meta.url, './ui/overview.tsx'),
		placement: workbench.route('/vault', {
			title: 'Vault',
			icon: workbench.icons.ShieldLock,
			navigation: { label: 'Vault' },
			order: 20,
		}),
	}),
})
