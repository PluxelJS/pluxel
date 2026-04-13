export const EXTENSION_FEDERATION_EXPOSE = './ui-module' as const
export const EXTENSION_FEDERATION_BUILD_ROOT = 'dist' as const
export const EXTENSION_FEDERATION_OUT_DIR = 'ui.remote' as const
export const EXTENSION_FEDERATION_MANIFEST_FILE = 'mf-manifest.json' as const
export const EXTENSION_FEDERATION_REMOTE_ENTRY_FILE = 'remoteEntry.js' as const
export const EXTENSION_FEDERATION_SHARE_STRATEGY = 'loaded-first' as const

// Keep the MF shared contract limited to plugin-facing surface areas.
//
// Do not add SignalDB's internal React/reactivity packages here.
// Plugin UI code should consume SignalDB only through `@pluxel/runtime/web/ui`
// (`pluginUi(...).use().db`), so the host only
// needs to share the runtime UI contract package itself.
export const extensionFederationSharedPackages = [
	'react',
	'react/jsx-runtime',
	'react/jsx-dev-runtime',
	'react-dom',
	'react-dom/client',
	'@tanstack/react-virtual',
	'@mantine/core',
	'@mantine/hooks',
	'@pluxel/runtime/web/ui',
] as const

export type ExtensionFederationSharedPackage = (typeof extensionFederationSharedPackages)[number]

export function sanitizeExtensionPluginName(pluginName: string): string {
	const normalized = String(pluginName ?? '')
		.trim()
		.replaceAll(/[^a-zA-Z0-9_-]+/g, '_')
		.replaceAll(/^_+|_+$/g, '')
	const suffix = stablePluginSuffix(pluginName)
	return normalized ? `${normalized}_${suffix}` : `plugin_${suffix}`
}

export function extensionFederationRemoteName(pluginName: string): string {
	return `pluxel_ext_${sanitizeExtensionPluginName(pluginName)}`
}

export function extensionFederationModuleId(
	exposedModule: string = EXTENSION_FEDERATION_EXPOSE,
): string {
	return exposedModule.startsWith('./') ? exposedModule.slice(2) : exposedModule.replace(/^\//, '')
}

export function extensionFederationBuildOutDir(
	baseDir: string = EXTENSION_FEDERATION_BUILD_ROOT,
): string {
	const normalized = String(baseDir ?? '')
		.trim()
		.replaceAll(/\/+$/g, '')
	return normalized ? `${normalized}/${EXTENSION_FEDERATION_OUT_DIR}` : EXTENSION_FEDERATION_OUT_DIR
}

export function extensionFederationManifestPath(
	dir: string = EXTENSION_FEDERATION_OUT_DIR,
): string {
	const normalized = String(dir ?? '')
		.trim()
		.replaceAll(/\/+$/g, '')
	return normalized
		? `${normalized}/${EXTENSION_FEDERATION_MANIFEST_FILE}`
		: EXTENSION_FEDERATION_MANIFEST_FILE
}

export function extensionFederationBuildManifestPath(
	baseDir: string = EXTENSION_FEDERATION_BUILD_ROOT,
): string {
	return extensionFederationManifestPath(extensionFederationBuildOutDir(baseDir))
}

function stablePluginSuffix(input: string): string {
	let hash = 2166136261
	for (let i = 0; i < input.length; i += 1) {
		hash ^= input.charCodeAt(i)
		hash = Math.imul(hash, 16777619)
	}
	return (hash >>> 0).toString(36)
}
