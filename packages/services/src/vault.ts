import type { RootContext } from '@pluxel/core'
import { installOwnerViewCapability, installRootCapability } from '@pluxel/core/host'
import { defineHostService } from '@pluxel/host'
import { Persistence } from './persistence/token'
import { Vault, VaultAdmin } from './vault/token'
import type { VaultService, VaultAdminService } from './vault/service'
import type { VaultServiceConfig } from './vault/types'

export { Vault, VaultAdmin } from './vault/token'
export type * from './vault/types'

/** Install encrypted owner storage. Persistence must be explicitly installed in the same Host. */
export function vault(config: VaultServiceConfig = {}) {
	const snapshot = Object.freeze({ ...config })
	const prepared = new WeakMap<RootContext, { vault: VaultService; admin: VaultAdminService }>()
	const backing = (ctx: RootContext) => {
		const value = prepared.get(ctx)
		if (!value) throw new Error('[services.vault] Vault has not been prepared')
		return value
	}
	return defineHostService({
		name: 'Vault',
		requires: { persistence: Persistence },
		capabilities: [
			installOwnerViewCapability(Vault, {
				property: 'vault',
				createRoot: (ctx) => backing(ctx as RootContext).vault,
				createView: (root, owner) => root.forOwner(owner),
			}),
			installRootCapability(VaultAdmin, {
				property: 'vaultAdmin',
				create: (ctx) => backing(ctx as RootContext).admin,
			}),
		],
		async prepare({ ctx, dependencies, effects }) {
			const { VaultService, VaultAdminService } = await import('./vault/service')
			await dependencies.persistence.preflight({ writable: true })
			const service = VaultService.create(
				ctx,
				snapshot,
				dependencies.persistence.namespace('vault'),
			)
			effects.defer(() => service.managedVault().flush(), { tag: 'VaultFlush', phase: 'shutdown' })
			const admin = new VaultAdminService(ctx, service)
			await admin.prepare()
			prepared.set(ctx, { vault: service, admin })
			effects.defer(
				() => {
					prepared.delete(ctx)
				},
				{ tag: 'VaultBacking', phase: 'shutdown' },
			)
		},
	})
}
