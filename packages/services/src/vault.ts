import { type RootContext } from '@pluxel/core'
import { installOwnerViewCapability, installRootCapability } from '@pluxel/core/host'
import { requireFs } from '@pluxel/core/internal'
import { defineHostService } from '@pluxel/host'
import { HostVaultBindings } from '@pluxel/host/bindings'
import { Vault, VaultAdmin } from './vault/token'
import type { VaultService, VaultAdminService } from './vault/service'
import { type VaultServiceConfig } from './vault/types'

export { Vault, VaultAdmin } from './vault/token'
export { VaultError } from './vault/error'
export type * from './vault/types'

/** Install owner-scoped Vault. Bindings-only mode does not open storage or create keys. */
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
			installRootCapability(HostVaultBindings, {
				create: (ctx) => ({
					install: (records) => backing(ctx as RootContext).vault.installBindings(records),
				}),
			}),
		],
		async prepare({ ctx, effects }) {
			const { VaultService, VaultAdminService } = await import('./vault/service')
			const storage = snapshot.backend === 'bindings' ? undefined : requireFs(ctx)
			const directory = await storage?.directory('services/vault', { writable: true })
			const service = VaultService.create(ctx, snapshot, directory)
			effects.defer(() => service.managedVault().flush(), { tag: 'VaultFlush', phase: 'shutdown' })
			const admin = new VaultAdminService(ctx, service)
			await admin.prepare()
			effects.defer(await service.managedVault().observeChanges(), {
				tag: 'VaultFileObservation',
				phase: 'shutdown',
			})
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
