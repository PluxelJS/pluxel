import { createHash } from 'node:crypto'
import { constants, realpathSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { parsePluginEntryAddress, pluginDefinitionIndexKey } from '@pluxel/core'
import {
	encodeControlData,
	isControlFilePath,
	parsePluginControlDependencies,
	parsePluginControlManifest,
	type PluginControlDependencies,
} from './control-manifest'
import type { PluginSourceDefinition } from './source-dependencies'

export const controlManifestLimit = 4 * 1024 * 1024
export const controlText = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

export function containedControlFile(root: string, file: string): string {
	const path = realpathSync(file)
	const local = relative(root, path).replaceAll('\\', '/')
	if (local === '..' || local.startsWith('../') || isAbsolute(local))
		throw new TypeError('Plugin control material escapes its actual package owner')
	return path
}

export function controlManifestFile(ownerRoot: string, declared: unknown): string {
	if (
		typeof declared !== 'string' ||
		!declared.startsWith('./') ||
		!isControlFilePath(declared.slice(2))
	)
		throw new TypeError('Package pluxel.control must name a relative control manifest')
	const root = realpathSync(ownerRoot)
	return containedControlFile(root, resolve(root, declared))
}

async function readControlBytes(path: string, limit: number): Promise<Buffer> {
	const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
	try {
		const stat = await file.stat()
		if (!stat.isFile() || stat.size > limit)
			throw new TypeError('Plugin control file must be a regular file within its byte budget')
		const bytes = Buffer.allocUnsafe(stat.size + 1)
		let length = 0
		while (length < bytes.length) {
			const { bytesRead } = await file.read(bytes, length, bytes.length - length)
			if (!bytesRead) break
			length += bytesRead
		}
		if (length !== stat.size) throw new TypeError('Plugin control file size changed during read')
		return bytes.subarray(0, length)
	} finally {
		await file.close()
	}
}

/**
 * Read a package's own declared root definitions without loading its entry. Supply its physical
 * directory and parsed package.json. A missing control manifest returns undefined. A declared
 * manifest with no matching roots returns an empty list. Invalid material rejects the read.
 */
export async function readPackageSourceDefinitions(
	packageRoot: string,
	packageManifest: Readonly<{ name?: unknown; pluxel?: unknown }>,
): Promise<readonly PluginSourceDefinition[] | undefined> {
	const { name, pluxel } = packageManifest
	parsePluginEntryAddress({ kind: 'package-root', packageName: name })
	if (pluxel === undefined) return undefined
	if (!pluxel || typeof pluxel !== 'object' || Array.isArray(pluxel))
		throw new TypeError('Package pluxel metadata must be an object')
	if (!Object.hasOwn(pluxel, 'control')) return undefined
	const path = controlManifestFile(packageRoot, (pluxel as { control: unknown }).control)
	const text = controlText.decode(await readControlBytes(path, controlManifestLimit))
	const { snapshot, ...manifest } = parsePluginControlManifest(JSON.parse(text))
	if (
		`sha256:${createHash('sha256').update(encodeControlData(manifest)).digest('hex')}` !== snapshot
	)
		throw new TypeError('Plugin control manifest snapshot mismatch')
	const file = manifest.files.find((item) => item.path === 'dependencies.json')
	let dependencies: ReadonlyMap<string, PluginControlDependencies> | undefined
	if (file) {
		const directory = dirname(path)
		const bytes = await readControlBytes(
			containedControlFile(directory, resolve(directory, file.path)),
			file.size,
		)
		if (
			bytes.length !== file.size ||
			createHash('sha256').update(bytes).digest('hex') !== file.sha256
		)
			throw new TypeError('Plugin dependency declarations differ from the control manifest')
		dependencies = parsePluginControlDependencies(controlText.decode(bytes), manifest)
	}
	return Object.freeze(
		manifest.definitions.flatMap(({ definition: address }): PluginSourceDefinition[] => {
			if (address.entry.kind !== 'package-root' || address.entry.packageName !== name) return []
			const facts = dependencies?.get(pluginDefinitionIndexKey(address))
			return [Object.freeze({ address, ...(facts && { dependencies: facts }) })]
		}),
	)
}
