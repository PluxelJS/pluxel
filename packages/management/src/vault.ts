import { ContextCapabilityMissingError, type Context } from '@pluxel/core'
import { resolveContextCapability } from '@pluxel/core/host'
import { VaultAdmin } from '@pluxel/services/vault'
export function optionalVaultAdmin(ctx: Context) {
	try {
		return resolveContextCapability(ctx.root, VaultAdmin)
	} catch (error) {
		if (
			error instanceof ContextCapabilityMissingError &&
			error.capability === 'services.vault-admin'
		)
			return undefined
		throw error
	}
}
