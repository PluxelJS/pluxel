/**
 * Elysia entries whose runtime exports carry application, adapter or WebSocket identity.
 *
 * The Vite bridge also accepts any other subpath exported by the host-installed Elysia package,
 * but only these entries are eagerly primed in the loader ModuleRunner.
 */
export const ELYSIA_SINGLETON_BRIDGE_MODULES = [
	'elysia',
	'elysia/adapter',
	'elysia/adapter/web-standard',
	'elysia/websocket',
	'elysia/ws',
] as const

/**
 * Returns whether a bare Elysia specifier belongs to the host's public package contract.
 *
 * Resolving through package exports keeps new public Elysia tools usable without accepting an
 * arbitrary `elysia/*` private-dist wildcard. `elysia/package.json` is data rather than an ESM
 * singleton namespace and is deliberately left to the normal resolver.
 */
export function isPublicElysiaSingletonSpecifier(
	specifier: string,
	isExported: (specifier: string) => boolean,
): boolean {
	if (specifier === 'elysia') return true
	return (
		specifier.startsWith('elysia/') && specifier !== 'elysia/package.json' && isExported(specifier)
	)
}
