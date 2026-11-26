import type { RpcTarget } from 'capnweb'
import { workbench } from '@pluxel/workbench'

export const VaultWorkbench = workbench.define(import.meta.url, {
	overview: workbench.view<RpcTarget>({
		renderer: './ui/overview.tsx',
		placement: {
			kind: 'route',
			path: '/vault',
			title: 'Vault',
			icon: 'shield-lock',
			navigation: { label: 'Vault' },
			order: 20,
		},
	}),
})
