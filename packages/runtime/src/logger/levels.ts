import type { Context } from '@pluxel/core'

const loadByConfigService = new WeakMap<object, Promise<void>>()

export async function ensureRuntimePluginPolicyLoaded(ctx: Context): Promise<void> {
	const configService = ctx.configService
	if (!configService) return

	const existing = loadByConfigService.get(configService as object)
	if (existing) return await existing

	const task = (async () => {
		await configService.ready
	})().catch((error) => {
		loadByConfigService.delete(configService as object)
		throw error
	})

	loadByConfigService.set(configService as object, task)
	return await task
}

export function persistRuntimePluginPolicy(ctx: Context): void {
	void ctx
}
