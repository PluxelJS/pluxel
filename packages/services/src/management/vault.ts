import type { Context } from '@pluxel/core'
import { createServiceRef } from '@pluxel/core/internal'
import { VaultAdmin } from '../vault'

const VaultAdminRef = createServiceRef(VaultAdmin)

export function optionalVaultAdmin(ctx: Context) {
	return ctx.root.service(VaultAdminRef)
}
