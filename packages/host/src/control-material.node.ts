import { readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { pluginDefinitionIndexKey, type PluginDefinitionAddress } from '@pluxel/core'
import type { PluginControlMetadata } from './catalog'
import type { InstalledPackageFacts } from './shared-packages'
import {
	isControlFilePath,
	parsePluginControlManifest,
	verifyPluginControlMaterialSync,
} from './control-manifest'

function contained(root: string, file: string): string {
	const path = realpathSync(file)
	const local = relative(root, path).replaceAll('\\', '/')
	if (local === '..' || local.startsWith('../') || isAbsolute(local))
		throw new TypeError('Plugin control material escapes its actual package owner')
	return path
}

/** Called once when a constructor's actual loaded-module ownership is first recorded. */
export function readLoadedPluginControl(
	owner: InstalledPackageFacts,
	definition: PluginDefinitionAddress,
): PluginControlMetadata {
	const declared = owner.manifest.pluxel?.control
	if (declared === undefined) return Object.freeze({ state: 'unavailable', reason: 'missing' })
	return readControlAt(owner.root, declared, definition)
}

/** Explicit generated-application origin; never inferred from a Plugin's source address. */
export function readApplicationPluginControl(
	module: string,
	manifest: string,
	definition: PluginDefinitionAddress,
): PluginControlMetadata {
	return readControlAt(dirname(module), manifest, definition)
}

function readControlAt(
	ownerRoot: string,
	declared: unknown,
	definition: PluginDefinitionAddress,
): PluginControlMetadata {
	try {
		if (
			typeof declared !== 'string' ||
			!declared.startsWith('./') ||
			!isControlFilePath(declared.slice(2))
		)
			throw new TypeError('Package pluxel.control must name a relative control manifest')
		const root = realpathSync(ownerRoot)
		const manifestFile = contained(root, resolve(root, declared))
		if (statSync(manifestFile).size > 4 * 1024 * 1024)
			throw new TypeError('Plugin control manifest exceeds its byte budget')
		const manifestText = readFileSync(manifestFile, 'utf8')
		const manifest = parsePluginControlManifest(JSON.parse(manifestText))
		const directory = dirname(manifestFile)
		const files: Record<string, string> = Object.create(null)
		files['manifest.json'] = manifestText
		for (const file of manifest.files) {
			const path = contained(directory, resolve(directory, file.path))
			if (statSync(path).size !== file.size)
				throw new TypeError(`Plugin control file size mismatch: ${file.path}`)
			files[file.path] = readFileSync(path, 'utf8')
		}
		verifyPluginControlMaterialSync(manifest, files, (content) =>
			createHash('sha256').update(content).digest('hex'),
		)
		const key = pluginDefinitionIndexKey(definition)
		const entry = manifest.definitions.find(
			(item) => pluginDefinitionIndexKey(item.definition) === key,
		)
		if (!entry) return Object.freeze({ state: 'unavailable', reason: 'missing' })
		return Object.freeze({
			state: 'available',
			format: 1,
			contracts: entry.contracts,
			material: Object.freeze({
				snapshot: manifest.snapshot,
				manifest,
				files: Object.freeze(files),
			}),
		})
	} catch (error) {
		return Object.freeze({
			state: 'unavailable',
			reason: 'analysis_failed',
			message: error instanceof Error ? error.message : String(error),
		})
	}
}
