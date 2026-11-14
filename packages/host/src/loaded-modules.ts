import {
	parsePluginDefinitionAddress,
	pluginDefinitionIndexKey,
	type PluginConstructor,
} from '@pluxel/core'
import { createHash } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { resolve, relative, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { HostApplicationFactory } from './application'
import { installedPackageFacts, type InstalledPackageFacts } from './shared-packages'
import { readApplicationPluginControl, readLoadedPluginControl } from './control-material.node.ts'
import type { PluginControlMetadata } from './catalog'

const owners = new WeakMap<
	PluginConstructor,
	Readonly<{ module: string; package: InstalledPackageFacts; control: PluginControlMetadata }>
>()

/** @internal Verified loaded module ownership, independent of catalog identity and execution policy. */
export function recordLoadedPluginModule(
	plugin: PluginConstructor,
	module: string,
	owner: InstalledPackageFacts,
): void {
	const existing = owners.get(plugin)
	if (existing && existing.package.root !== owner.root)
		throw new TypeError('[host] loaded Plugin has conflicting physical package owners')
	// Node may retain the constructor after this package's files have changed. Its
	// original control snapshot must never be relabelled from newer sidecar files.
	if (existing) return
	owners.set(
		plugin,
		Object.freeze({
			module,
			package: owner,
			control: readLoadedPluginControl(owner, plugin.definitionAddress()),
		}),
	)
}

export function readLoadedPluginModule(plugin: PluginConstructor) {
	return owners.get(plugin)
}

type LoadedApplication = {
	module: string
	controlManifest?: string
	controls: Map<PluginConstructor, PluginControlMetadata>
}
const applications = new WeakMap<HostApplicationFactory, LoadedApplication>()
/** @internal Generated modules entry records its own output; no paths are inferred from source identity. */
export function recordLoadedHostApplication(
	factory: HostApplicationFactory,
	moduleURL: string,
	options?: Readonly<{ controlManifest?: string }>,
): void {
	const module = fileURLToPath(moduleURL)
	const existing = applications.get(factory)
	if (existing) {
		if (existing.module !== module || existing.controlManifest !== options?.controlManifest)
			throw new TypeError('[host] loaded application has conflicting output origins')
		return
	}
	applications.set(factory, {
		module,
		controlManifest: options?.controlManifest,
		controls: new Map(),
	})
}
/** @internal Exact compiled factory location; source factories have no loaded output owner. */
export function readLoadedHostApplicationModule(
	factory: HostApplicationFactory,
): string | undefined {
	return applications.get(factory)?.module
}

/** Exact constructor selected by this evaluated generated application. */
export function readLoadedApplicationControl(
	factory: HostApplicationFactory,
	plugin: PluginConstructor,
): PluginControlMetadata | undefined {
	return applications.get(factory)?.controls.get(plugin)
}
export function recordLoadedApplicationPlugins(
	factory: HostApplicationFactory,
	plugins: readonly PluginConstructor[],
): void {
	const application = applications.get(factory)
	if (!application) return
	const { module } = application
	if (application.controlManifest !== undefined) {
		for (const plugin of plugins)
			if (!application.controls.has(plugin))
				application.controls.set(
					plugin,
					readApplicationPluginControl(
						module,
						application.controlManifest,
						plugin.definitionAddress(),
					),
				)
		return
	}
	const owner = installedPackageFacts(module)
	if (!owner || owner.manifest.pluxel?.modules?.version !== 1)
		throw new TypeError('[host] modules application lacks its owning package metadata')
	const inventory = JSON.parse(
		readFileSync(resolve(owner.root, 'pluxel-modules.json'), 'utf8'),
	) as { version?: unknown; modules?: unknown; definitions?: unknown }
	if (
		inventory.version !== 1 ||
		!Array.isArray(inventory.modules) ||
		!Array.isArray(inventory.definitions)
	)
		throw new TypeError('[host] invalid modules application inventory')
	const definitions = new Set<string>()
	for (const item of inventory.definitions) {
		const key = pluginDefinitionIndexKey(parsePluginDefinitionAddress(item))
		if (definitions.has(key)) throw new TypeError('[host] duplicate modules application definition')
		definitions.add(key)
	}
	const files = new Set<string>()
	for (const record of inventory.modules) {
		if (
			!record ||
			typeof record !== 'object' ||
			typeof record.file !== 'string' ||
			!record.file.endsWith('.mjs') ||
			isAbsolute(record.file) ||
			record.file.split(/[\\/]/).includes('..') ||
			!/^[a-f0-9]{64}$/.test(record.sha256)
		)
			throw new TypeError('[host] invalid modules application inventory entry')
		const file = realpathSync(resolve(owner.root, record.file))
		const ownerRelative = relative(owner.root, file)
		if (
			isAbsolute(ownerRelative) ||
			ownerRelative === '..' ||
			ownerRelative.startsWith('../') ||
			files.has(file)
		)
			throw new TypeError('[host] modules application inventory escapes or duplicates its owner')
		if (createHash('sha256').update(readFileSync(file)).digest('hex') !== record.sha256)
			throw new TypeError(`[host] modules application digest mismatch: ${record.file}`)
		files.add(file)
	}
	if (!files.has(realpathSync(module)))
		throw new TypeError('[host] loaded application entry is absent from its modules inventory')
	for (const plugin of plugins) {
		const definition = plugin.definitionAddress()
		if (definitions.has(pluginDefinitionIndexKey(definition)))
			recordLoadedPluginModule(plugin, module, owner)
	}
}
