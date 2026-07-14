export const WORKBENCH_FEDERATION_EXPOSE = './ui-module' as const
export const WORKBENCH_FEDERATION_BUILD_ROOT = 'dist' as const
export const WORKBENCH_FEDERATION_OUT_DIR = 'workbench' as const
export const WORKBENCH_FEDERATION_MANIFEST_FILE = 'mf-manifest.json' as const
export const WORKBENCH_FEDERATION_REMOTE_ENTRY_FILE = 'remoteEntry.js' as const
export const WORKBENCH_FEDERATION_SHARE_STRATEGY = 'loaded-first' as const

// Keep the MF shared contract limited to plugin-facing surface areas.
//
// Do not add SignalDB's internal React/reactivity packages here.
// Workbench UI code consumes resources through the workbench UI runtime,
// so the host only needs to share that contract package.
export const workbenchFederationSharedPackages = [
	'react',
	'react/jsx-runtime',
	'react/jsx-dev-runtime',
	'react-dom',
	'react-dom/client',
	'@tanstack/react-virtual',
	'@mantine/core',
	'@mantine/hooks',
	'@pluxel/runtime/workbench/contract',
	'@pluxel/runtime/workbench/ui',
] as const

export type WorkbenchFederationSharedPackage = (typeof workbenchFederationSharedPackages)[number]

export function sanitizeWorkbenchOwnerName(pluginName: string): string {
	const normalized = String(pluginName ?? '')
		.trim()
		.replaceAll(/[^a-zA-Z0-9_-]+/g, '_')
		.replaceAll(/^_+|_+$/g, '')
	const suffix = stablePluginSuffix(pluginName)
	return normalized ? `${normalized}_${suffix}` : `plugin_${suffix}`
}

export function workbenchFederationRemoteName(pluginName: string): string {
	return `pluxel_workbench_${sanitizeWorkbenchOwnerName(pluginName)}`
}

export function workbenchFederationModuleId(
	exposedModule: string = WORKBENCH_FEDERATION_EXPOSE,
): string {
	return exposedModule.startsWith('./') ? exposedModule.slice(2) : exposedModule.replace(/^\//, '')
}

export function workbenchFederationBuildOutDir(
	pluginName: string,
	baseDir: string = WORKBENCH_FEDERATION_BUILD_ROOT,
): string {
	const normalized = String(baseDir ?? '')
		.trim()
		.replaceAll(/\/+$/g, '')
	const root = normalized
		? `${normalized}/${WORKBENCH_FEDERATION_OUT_DIR}`
		: WORKBENCH_FEDERATION_OUT_DIR
	return `${root}/${sanitizeWorkbenchOwnerName(pluginName)}`
}

export function workbenchFederationManifestPath(
	pluginName: string,
	dir: string = WORKBENCH_FEDERATION_OUT_DIR,
): string {
	const normalized = String(dir ?? '')
		.trim()
		.replaceAll(/\/+$/g, '')
	const owner = sanitizeWorkbenchOwnerName(pluginName)
	return normalized
		? `${normalized}/${owner}/${WORKBENCH_FEDERATION_MANIFEST_FILE}`
		: `${owner}/${WORKBENCH_FEDERATION_MANIFEST_FILE}`
}

export function workbenchFederationBuildManifestPath(
	pluginName: string,
	baseDir: string = WORKBENCH_FEDERATION_BUILD_ROOT,
): string {
	const normalized = String(baseDir ?? '')
		.trim()
		.replaceAll(/\/+$/g, '')
	const root = normalized
		? `${normalized}/${WORKBENCH_FEDERATION_OUT_DIR}`
		: WORKBENCH_FEDERATION_OUT_DIR
	return workbenchFederationManifestPath(pluginName, root)
}

function stablePluginSuffix(input: string): string {
	let hash = 2166136261
	for (let i = 0; i < input.length; i += 1) {
		hash ^= input.charCodeAt(i)
		hash = Math.imul(hash, 16777619)
	}
	return (hash >>> 0).toString(36)
}
