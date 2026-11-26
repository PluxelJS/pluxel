import type { MarketBindings } from '../bindings'

export function isHostedRegistryPath(path: string): boolean {
	return path === '/npm' || path.startsWith('/npm/')
}

export function hasHostedRegistryBindings(env: MarketBindings): boolean {
	return (
		env.HOSTED_REGISTRY_URL !== undefined ||
		env.HOSTED_ARCHIVES !== undefined ||
		env.HOSTED_PUBLISHERS !== undefined ||
		env.HOSTED_READ_TOKEN !== undefined
	)
}
