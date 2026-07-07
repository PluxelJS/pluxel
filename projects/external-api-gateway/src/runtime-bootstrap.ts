import { bootstrapHostVault } from '@pluxel/runtime/services/vault'

type VaultHostContext = Parameters<typeof bootstrapHostVault>[0] & {
	root: {
		vaultAdmin: {
			ensureHostKey(): Promise<string>
		}
	}
}

export async function prepareExternalGatewayRuntime(ctx: VaultHostContext): Promise<void> {
	await ctx.root.vaultAdmin.ensureHostKey()
	const vault = await bootstrapHostVault(ctx)
	if (vault.present && !vault.unlocked) {
		throw new Error('External API gateway requires an unlocked vault before plugins start.')
	}
}
