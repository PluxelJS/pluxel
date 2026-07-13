export const MANAGEMENT_FEDERATION_EXPOSE = './ui-module' as const
export const MANAGEMENT_FEDERATION_BUILD_ROOT = 'dist' as const
export const MANAGEMENT_FEDERATION_OUT_DIR = 'management' as const
export const MANAGEMENT_FEDERATION_MANIFEST_FILE = 'mf-manifest.json' as const
export const MANAGEMENT_FEDERATION_REMOTE_ENTRY_FILE = 'remoteEntry.js' as const
export const MANAGEMENT_FEDERATION_SHARE_STRATEGY = 'loaded-first' as const

// Keep the MF shared contract limited to plugin-facing surface areas.
//
// Do not add SignalDB's internal React/reactivity packages here.
// Management UI code consumes resources through the management UI runtime,
// so the host only needs to share that contract package.
export const managementFederationSharedPackages = [
	'react',
	'react/jsx-runtime',
	'react/jsx-dev-runtime',
	'react-dom',
	'react-dom/client',
	'@tanstack/react-virtual',
	'@mantine/core',
	'@mantine/hooks',
	'@pluxel/runtime/management/ui',
] as const

export type ManagementFederationSharedPackage = (typeof managementFederationSharedPackages)[number]

export function sanitizeManagementOwnerName(pluginName: string): string {
	const normalized = String(pluginName ?? '')
		.trim()
		.replaceAll(/[^a-zA-Z0-9_-]+/g, '_')
		.replaceAll(/^_+|_+$/g, '')
	const suffix = stablePluginSuffix(pluginName)
	return normalized ? `${normalized}_${suffix}` : `plugin_${suffix}`
}

export function managementFederationRemoteName(pluginName: string): string {
	return `pluxel_management_${sanitizeManagementOwnerName(pluginName)}`
}

export function managementFederationModuleId(
	exposedModule: string = MANAGEMENT_FEDERATION_EXPOSE,
): string {
	return exposedModule.startsWith('./') ? exposedModule.slice(2) : exposedModule.replace(/^\//, '')
}

export function managementFederationBuildOutDir(
	pluginName: string,
	baseDir: string = MANAGEMENT_FEDERATION_BUILD_ROOT,
): string {
	const normalized = String(baseDir ?? '')
		.trim()
		.replaceAll(/\/+$/g, '')
	const root = normalized
		? `${normalized}/${MANAGEMENT_FEDERATION_OUT_DIR}`
		: MANAGEMENT_FEDERATION_OUT_DIR
	return `${root}/${sanitizeManagementOwnerName(pluginName)}`
}

export function managementFederationManifestPath(
	pluginName: string,
	dir: string = MANAGEMENT_FEDERATION_OUT_DIR,
): string {
	const normalized = String(dir ?? '')
		.trim()
		.replaceAll(/\/+$/g, '')
	const owner = sanitizeManagementOwnerName(pluginName)
	return normalized
		? `${normalized}/${owner}/${MANAGEMENT_FEDERATION_MANIFEST_FILE}`
		: `${owner}/${MANAGEMENT_FEDERATION_MANIFEST_FILE}`
}

export function managementFederationBuildManifestPath(
	pluginName: string,
	baseDir: string = MANAGEMENT_FEDERATION_BUILD_ROOT,
): string {
	const normalized = String(baseDir ?? '')
		.trim()
		.replaceAll(/\/+$/g, '')
	const root = normalized
		? `${normalized}/${MANAGEMENT_FEDERATION_OUT_DIR}`
		: MANAGEMENT_FEDERATION_OUT_DIR
	return managementFederationManifestPath(pluginName, root)
}

function stablePluginSuffix(input: string): string {
	let hash = 2166136261
	for (let i = 0; i < input.length; i += 1) {
		hash ^= input.charCodeAt(i)
		hash = Math.imul(hash, 16777619)
	}
	return (hash >>> 0).toString(36)
}
