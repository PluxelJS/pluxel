import type { Context as PluxelContext } from '@pluxel/core'
import type { VaultAdminState } from '../vault/types'

/**
 * Host startup security bootstrap.
 *
 * Rules:
 * - only create host identity for an absent vault
 * - never rewrite identity material for an existing sealed vault
 * - always finish with an explicit preflight
 */
export async function bootstrapHostVault(
	ctx: Pick<PluxelContext, 'root'>,
): Promise<VaultAdminState> {
	const vault = await ctx.root.vaultAdmin.describe()
	if (!vault.present && !vault.hostIdentityPresent) {
		await ctx.root.vaultAdmin.ensureHostKey()
	}
	return await ctx.root.vaultAdmin.preflight()
}
