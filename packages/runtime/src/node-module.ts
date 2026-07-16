const NODE_MODULE_DECLARATION = Symbol.for('pluxel:node-module-declaration')

declare const nodeModuleBrand: unique symbol

/** A separately-built Node ESM entry owned by the declaring source module. */
export type NodeModuleDeclaration = Readonly<{ [nodeModuleBrand]: true }>

export type NodeModuleCleanup = () => void | Promise<void>
export type NodeModuleSetup = (
	url: URL,
) => void | NodeModuleCleanup | Promise<void | NodeModuleCleanup>

type NodeModuleDescriptor = Readonly<{
	moduleUrl: string
	entryPath: string
	artifactKey?: string
}>

/** Declare a Node ESM source entry for `ctx.nodeModules.use()`. */
export function defineNodeModule(
	moduleUrl: string | URL,
	entryPath: string,
): NodeModuleDeclaration {
	const normalizedModuleUrl = String(moduleUrl)
	const normalizedEntryPath = String(entryPath ?? '').trim()
	if (!normalizedModuleUrl) {
		throw new Error('[pluxel/runtime] defineNodeModule(): module URL is required')
	}
	if (!normalizedEntryPath) {
		throw new Error('[pluxel/runtime] defineNodeModule(): entry path is required')
	}
	const parsed = new URL(normalizedModuleUrl)
	if (parsed.protocol !== 'file:') {
		throw new Error('[pluxel/runtime] defineNodeModule(): module URL must use the file protocol')
	}
	const artifactKey = readLoweredArtifactKey(arguments[2])
	return Object.freeze({
		[NODE_MODULE_DECLARATION]: Object.freeze({
			moduleUrl: parsed.href,
			entryPath: normalizedEntryPath,
			...(artifactKey ? { artifactKey } : {}),
		} satisfies NodeModuleDescriptor),
	}) as unknown as NodeModuleDeclaration
}

/** @internal Toolchain/runtime bridge; not exported from the author entry. */
export function readNodeModuleDeclaration(
	declaration: NodeModuleDeclaration,
): NodeModuleDescriptor {
	const value = (declaration as unknown as Record<PropertyKey, unknown>)[NODE_MODULE_DECLARATION]
	if (!value || typeof value !== 'object') {
		throw new TypeError('[pluxel/runtime] invalid Node module declaration')
	}
	return value as NodeModuleDescriptor
}

function readLoweredArtifactKey(value: unknown): string | undefined {
	if (typeof value !== 'string') return undefined
	const normalized = value.trim()
	return normalized || undefined
}
