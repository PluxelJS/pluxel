import { registerHooks } from 'node:module'
import { realpath } from 'node:fs/promises'
import { dirname, extname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { pluginDefinitionAddressOf, type PluginConstructor } from '@pluxel/core'
import { collectPluginModuleExports } from './module'
import {
	assertSharedRuntimeAdmission,
	admitSharedRuntimeOwner,
	installedSharedRuntimeVersion,
	participatesInSharedRuntime,
	readSharedRuntimePackage,
	sharedRuntimeForImport,
} from './shared-runtime'
import type { HostApplicationFactory } from './application'
import { recordLoadedPluginModule, readLoadedPluginModule } from './loaded-modules'
import {
	assertSharedPackageVersion,
	hostSharedPackages,
	importPackageName,
	installedPackageFacts,
	resolveNativeImport,
} from './shared-packages'

type LoadedClosure = Readonly<{ modules: readonly string[]; length: number }>
const closures = new Map<string, LoadedClosure>()
const bindings = new Map<string, { key: string; users: number; cached: boolean }>()

/** Startup-only loading. Owned late imports keep the binding until Host shutdown has drained. */
export async function createNativeSourceLoader(options: {
	root: string
	sharedPackages?: readonly string[]
}) {
	const shared = hostSharedPackages({ root: options.root, packages: options.sharedPackages })
	const key = JSON.stringify([...shared].sort(([a], [b]) => a.localeCompare(b)))
	const entries = new Set<string>()
	const owned = new Set<string>()
	const loaded = new Set<string>()
	const order: string[] = []
	const pending = new Set<string>()
	const recordLoaded = (url: string): void => {
		if (loaded.has(url)) return
		loaded.add(url)
		order.push(url)
		pending.add(url)
	}
	let closed = false
	const admit = (url: string): void => {
		if (owned.has(url)) return
		const active = bindings.get(url)
		if (active && active.key !== key)
			throw Object.assign(new Error(`[host] conflicting native shared bindings for ${url}`), {
				code: 'PLUGIN_SHARED_BINDING_CONFLICT',
			})
		bindings.set(url, { key, users: (active?.users ?? 0) + 1, cached: active?.cached ?? false })
		owned.add(url)
	}
	const hook = registerHooks({
		load(url, context, next) {
			if (
				owned.has(url) &&
				url.startsWith('file:') &&
				/\.(?:[cm]?ts|tsx)$/.test(fileURLToPath(url))
			)
				throw new TypeError(`[host] native Plugin input must be precompiled: ${url}`)
			const result = next(url, context)
			if (entries.has(url) && result.format !== 'module')
				throw new TypeError(`[host] native Plugin entry must be precompiled ESM: ${url}`)
			if (owned.has(url)) {
				recordLoaded(url)
				bindings.get(url)!.cached = true
			}
			return result
		},
		resolve(specifier, context, next) {
			if (!entries.has(specifier) && (!context.parentURL || !owned.has(context.parentURL)))
				return next(specifier, context)
			const runtime = sharedRuntimeForImport(specifier)
			const runtimeBase = runtime && shared.get(runtime.owner)
			if (runtime && runtimeBase && context.parentURL?.startsWith('file:')) {
				const publisher = readSharedRuntimePackage(fileURLToPath(context.parentURL), runtime)
				if (
					publisher &&
					(publisher.owner === runtime.owner || participatesInSharedRuntime(publisher))
				) {
					const ownerEntry = resolveNativeImport(runtimeBase, runtime.entry)
					const canonicalRoot = resolveNativeImport(dirname(ownerEntry), runtime.name)
					let actual: { url: string } | undefined
					try {
						actual = next(specifier, context)
					} catch (cause) {
						if (
							!(
								cause instanceof Error &&
								'code' in cause &&
								['MODULE_NOT_FOUND', 'ERR_MODULE_NOT_FOUND'].includes(String(cause.code))
							)
						)
							throw cause
					}
					const admission = {
						runtime,
						package: publisher,
						supportedVersion: admitSharedRuntimeOwner(
							ownerEntry,
							canonicalRoot,
							runtime,
							'host/native',
						),
						actualVersion: actual?.url.startsWith('file:')
							? installedSharedRuntimeVersion(fileURLToPath(actual.url), runtime)
							: undefined,
						actualEntry: actual?.url,
						development: false,
						operation: 'host/native',
					}
					assertSharedRuntimeAdmission(admission)
					const canonical = resolveNativeImport(dirname(ownerEntry), specifier)
					const url = pathToFileURL(canonical).href
					admit(url)
					return { url, shortCircuit: true }
				}
			}
			const selected = shared.get(importPackageName(specifier))
			const result = next(specifier, context)
			if (selected) {
				const canonical = resolveNativeImport(selected, specifier)
				assertSharedPackageVersion({
					specifier,
					actual: fileURLToPath(result.url),
					canonical,
					importer: context.parentURL?.startsWith('file:')
						? fileURLToPath(context.parentURL)
						: undefined,
				})
				const url = pathToFileURL(canonical).href
				// Driver-owned Core/Host are already authoritative; selected domains still bind
				// their own public dependency imports inside this application's scope.
				if (!['@pluxel/core', '@pluxel/host'].includes(importPackageName(specifier))) admit(url)
				return { url, shortCircuit: true }
			}
			if (result.url.startsWith('file:')) {
				admit(result.url)
			}
			return result
		},
	})
	async function importModule(path: string): Promise<Record<string, unknown>> {
		if (closed) throw new Error('[host] native source loader is closed')
		path = await realpath(path)
		if (!['.js', '.mjs'].includes(extname(path)))
			throw new TypeError(`[host] native Plugin entry must be precompiled ESM: ${path}`)
		const url = pathToFileURL(path).href
		admit(url)
		entries.add(url)
		const previous = closures.get(url)
		if (previous)
			for (let index = 0; index < previous.length; index++) {
				const module = previous.modules[index]!
				admit(module)
				recordLoaded(module)
			}
		const namespace: Record<string, unknown> = await import(url)
		if (!loaded.has(url) && !previous)
			throw Object.assign(
				new Error(`[host] native entry was evaluated before its shared bindings: ${path}`),
				{ code: 'PLUGIN_SHARED_BINDING_CONFLICT' },
			)
		// Find the actual defining package in the evaluated closure, including re-export wrappers.
		for (const module of pending) {
			const file = fileURLToPath(module)
			if (!['.mjs', '.js', '.cjs'].includes(extname(file))) continue
			const owner = installedPackageFacts(file)
			if (!owner) continue
			for (const plugin of collectPluginModuleExports(await import(module))) {
				const entry = pluginDefinitionAddressOf(plugin).entry
				if (
					(entry.kind === 'source-entry' &&
						typeof owner.manifest.pluxel?.artifactRoot === 'string') ||
					(entry.kind !== 'source-entry' && entry.packageName === owner.name)
				)
					recordLoadedPluginModule(plugin, file, owner)
			}
			// One loader reuses only successful admission of its evaluated namespace.
			// Missing owners and failed ABI/ownership checks remain unprocessed.
			pending.delete(module)
		}
		// Entry facts keep their successful cumulative prefix while sharing this
		// loader's unique URL storage. Later imports cannot extend an earlier prefix.
		closures.set(url, Object.freeze({ modules: order, length: order.length }))
		return namespace
	}
	return {
		async loadApplication(path: string): Promise<HostApplicationFactory> {
			const namespace = await importModule(path)
			if (typeof namespace.default !== 'function')
				throw new TypeError(`[host] native application must export a default factory: ${path}`)
			return namespace.default as HostApplicationFactory
		},
		async load(path: string): Promise<readonly PluginConstructor[]> {
			const plugins = collectPluginModuleExports(await importModule(path))
			if (plugins.length === 0)
				throw new TypeError(`[host] Plugin source exports no lowered Plugin definitions: ${path}`)
			return plugins
		},
		async recordFixed(plugins: readonly PluginConstructor[]): Promise<void> {
			for (const plugin of plugins) {
				if (readLoadedPluginModule(plugin)) continue
				const definition = pluginDefinitionAddressOf(plugin)
				if (definition.entry.kind === 'source-entry') continue
				const specifier =
					definition.entry.packageName +
					(definition.entry.kind === 'package-subpath' ? definition.entry.subpath.slice(1) : '')
				const file = resolveNativeImport(options.root, specifier)
				const publicExports = await import(pathToFileURL(file).href)
				if (publicExports[definition.exportName] !== plugin)
					throw new TypeError(
						`[host] fixed Plugin identity conflicts with installed public entry: ${specifier}::${definition.exportName}`,
					)
				const owner = installedPackageFacts(file)!
				recordLoadedPluginModule(plugin, file, owner)
			}
		},
		close(): void {
			if (closed) return
			closed = true
			hook.deregister()
			Object.freeze(order)
			for (const url of owned) {
				const active = bindings.get(url)!
				// Node retains this ESM namespace after drain; another binding cannot reinterpret it.
				if (active.cached || active.users > 1)
					bindings.set(url, { ...active, users: active.users - 1 })
				else bindings.delete(url)
			}
			owned.clear()
			entries.clear()
			loaded.clear()
			pending.clear()
		},
	}
}
