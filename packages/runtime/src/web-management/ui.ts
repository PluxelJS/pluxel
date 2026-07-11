import { fileURLToPath } from 'node:url'

export interface PluginUiSourceDeclaration {
	/** Source entry consumed only by the UI build/dev pipeline. */
	entryPath: string
}

export interface PluginUiModuleDeclaration {
	readonly entryPath: string
}

function normalizeUiConfig(input: string | PluginUiSourceDeclaration): PluginUiSourceDeclaration {
	const entryPath =
		typeof input === 'string' ? String(input).trim() : String(input.entryPath ?? '').trim()
	return { entryPath }
}

export function ui(input: string | PluginUiSourceDeclaration): PluginUiModuleDeclaration
export function ui(moduleUrl: string | URL, entryPath: string): PluginUiModuleDeclaration
export function ui(
	input: string | URL | PluginUiSourceDeclaration,
	moduleRelativeEntry?: string,
): PluginUiModuleDeclaration {
	const declaration = moduleRelativeEntry
		? normalizeUiConfig(fileURLToPath(new URL(moduleRelativeEntry, input as string | URL)))
		: normalizeUiConfig(input as string | PluginUiSourceDeclaration)
	if (!declaration.entryPath) {
		throw new Error('[pluxel/runtime/web-management] ui(): entryPath required')
	}
	return Object.freeze({ entryPath: declaration.entryPath })
}
