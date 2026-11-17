import { readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import {
	pluginDefinitionIndexKey,
	type PluginDefinitionAddress,
	type RootContext,
} from '@pluxel/core'
import type { PluginControlMetadata } from './catalog'
import {
	installedPackageFacts,
	resolveNativeImport,
	type InstalledPackageFacts,
} from './shared-packages'
import { getInstalledServiceDefinitions, readServiceDefinition } from '@pluxel/core/internal'
import {
	readHostServiceControls,
	setServiceControlMaterial,
	type ServiceControlMaterial,
} from './service-control'
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
		const material = readControlMaterialAt(ownerRoot, declared)
		const { manifest } = material
		const key = pluginDefinitionIndexKey(definition)
		const entry = manifest.definitions.find(
			(item) => pluginDefinitionIndexKey(item.definition) === key,
		)
		if (!entry) return Object.freeze({ state: 'unavailable', reason: 'missing' })
		return Object.freeze({
			state: 'available',
			format: 2,
			contracts: entry.contracts,
			material,
		})
	} catch (error) {
		return Object.freeze({
			state: 'unavailable',
			reason: 'analysis_failed',
			message: error instanceof Error ? error.message : String(error),
		})
	}
}

/** Read and fully verify one explicit physical control material owner. */
function readControlMaterialAt(ownerRoot: string, declared: unknown): ServiceControlMaterial {
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
	return Object.freeze({ snapshot: manifest.snapshot, manifest, files: Object.freeze(files) })
}

/**
 * Select a public entry by canonical address, then prove physical ownership by exact
 * namespace equality before accepting its package's control sidecar.
 */
export async function loadNativeHostServiceControls(
	ctx: RootContext,
	root: string,
	application?: Readonly<{ module: string; controlManifest?: string }>,
): Promise<void> {
	const records = readHostServiceControls(ctx)
	const accepted = new Set(records.filter((item) => item.material).map((item) => item.target))
	const available = new Set(records.flatMap((item) => (item.material ? [item.material] : [])))
	const verified = new Map<string, ServiceControlMaterial>()
	const read = (ownerRoot: string, declared: unknown): ServiceControlMaterial => {
		const key = `${ownerRoot}\0${String(declared)}`
		let material = verified.get(key)
		if (!material) {
			material = readControlMaterialAt(ownerRoot, declared)
			verified.set(key, material)
			available.add(material)
		}
		return material
	}
	let applicationMaterial: ServiceControlMaterial | undefined
	if (application?.controlManifest !== undefined)
		applicationMaterial = read(dirname(application.module), application.controlManifest)
	const installed = getInstalledServiceDefinitions(ctx)
	const native = new Set<(typeof installed)[number]>()
	const owned = new Map<(typeof installed)[number], ServiceControlMaterial>()
	// An installer package may publish a declaration imported from another package.
	// Discover only the owners of actual installed declarations before matching that material.
	for (const target of installed) {
		if (accepted.has(target)) continue
		const metadata = readServiceDefinition(target),
			definition = metadata.definition
		if (!definition || metadata.optional) continue
		const index = pluginDefinitionIndexKey(definition)
		if (
			applicationMaterial?.manifest.services.some(
				(entry) => pluginDefinitionIndexKey(entry.definition) === index,
			)
		) {
			setServiceControlMaterial(target, applicationMaterial)
			continue
		}
		if (definition.entry.kind === 'source-entry') continue
		const specifier =
			definition.entry.packageName +
			(definition.entry.kind === 'package-subpath' ? definition.entry.subpath.slice(1) : '')
		for (const directory of new Set([root, dirname(fileURLToPath(import.meta.url))])) {
			let module: string
			try {
				module = resolveNativeImport(directory, specifier)
			} catch (cause) {
				const code = cause && typeof cause === 'object' && 'code' in cause ? cause.code : undefined
				if (code === 'MODULE_NOT_FOUND' || code === 'ERR_PACKAGE_PATH_NOT_EXPORTED') continue
				throw cause
			}
			const namespace = await import(pathToFileURL(module).href)
			if (namespace[definition.exportName] !== target) continue
			native.add(target)
			const owner = installedPackageFacts(module)
			if (owner?.manifest.pluxel?.control === undefined) break
			const material = read(owner.root, owner.manifest.pluxel.control)
			owned.set(target, material)
			break
		}
	}
	for (const target of native) {
		const definition = readServiceDefinition(target).definition!
		const key = pluginDefinitionIndexKey(definition)
		const matches = [...available].flatMap((material) => {
			const entry = material.manifest.services.find(
				(candidate) => pluginDefinitionIndexKey(candidate.definition) === key,
			)
			return entry ? [{ material, entry }] : []
		})
		const declaration = owned.get(target)
		const own = matches.find((item) => item.material === declaration)
		const selected = own ?? matches[0]
		if (!selected) continue
		if (
			!own &&
			matches.some(
				(item) =>
					item.entry.contract !== selected.entry.contract ||
					item.entry.access !== selected.entry.access,
			)
		)
			throw new TypeError('Installed service materials disagree on their declaration contract')
		setServiceControlMaterial(target, selected.material)
	}
}
