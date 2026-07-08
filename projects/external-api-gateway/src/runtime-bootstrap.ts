import '@pluxel/runtime/services/vault'

type VaultPreparedContext = {
	prepareServices(): Promise<void>
	root: unknown
}

type VaultPreparedRoot = {
	vaultAdmin: {
		describe(): Promise<{ present: boolean; unlocked: boolean }>
	}
}

export async function prepareExternalGatewayRuntime(ctx: VaultPreparedContext): Promise<void> {
	await ctx.prepareServices()
	const vault = await (ctx.root as VaultPreparedRoot).vaultAdmin.describe()
	if (vault.present && !vault.unlocked) {
		throw new Error('External API gateway requires an unlocked vault before plugins start.')
	}
}
