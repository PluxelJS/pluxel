import {
	InputBindingError,
	fail,
	record,
	schema,
	configSchema,
	configBindingProof,
	type InputSchema,
} from './input-binding-contract'
import {
	parsePluginNodeAddress,
	pluginNodeIndexKey,
	type PluginConstructor,
	type PluginNodeAddress,
} from '@pluxel/core'
import type { PluginConfigRecordSnapshot } from '@pluxel/core/services'
import type { StandardSchemaV1 } from '@standard-schema/spec'
import { projectRawInput, type Schema } from 'valibot-form'
import type { HostApplication } from './host'
import type { HostStartupContext } from './application'
import type { HostVaultBindingRecord } from './bindings'
import { configLeafPaths, configPathsOverlap } from './config-paths'
import { snapshotConfigInput, type ConfigBindingProof } from './config-records'

type Source = Readonly<{ path: readonly string[]; kind: 'env'; name: string }>
export type ResolvedInputBindings = Readonly<{
	bindings: readonly ConfigBindingProof[]
	records: readonly PluginConfigRecordSnapshot[]
	declarationSources: readonly {
		owner: PluginNodeAddress
		path: readonly string[]
		kind: 'file'
		name: string
	}[]
	overlays: readonly {
		owner: PluginNodeAddress
		config: Readonly<Record<string, unknown>>
		sources: readonly Source[]
	}[]
	vaultBindings: readonly HostVaultBindingRecord[]
}>

function envelope(
	value: unknown,
	fields: readonly string[],
	label: string,
): asserts value is Record<string, unknown> {
	if (!record(value)) fail(`[host] ${label} must be a plain object`)
	for (const key of Reflect.ownKeys(value)) {
		if (typeof key !== 'string' || !fields.includes(key)) fail(`[host] Unsupported ${label} field`)
		const property = Object.getOwnPropertyDescriptor(value, key)!
		if (!property.enumerable || !('value' in property))
			fail(`[host] ${label} must contain data properties`)
	}
}
function validateNamespace(namespace: unknown): void {
	if (
		namespace !== undefined &&
		(typeof namespace !== 'string' || !namespace || namespace.includes('\0'))
	)
		fail('[host] Invalid Vault namespace')
}
function dataEntries(value: unknown, label: string): [string, unknown][] {
	if (!record(value)) fail(`[host] ${label} must be a plain object`)
	return Reflect.ownKeys(value).map((key) => {
		if (typeof key !== 'string') fail(`[host] ${label} keys must be strings`)
		segment(key)
		const property = Object.getOwnPropertyDescriptor(value, key)!
		if (!property.enumerable || !('value' in property))
			fail(`[host] ${label} must contain data properties`)
		return [key, property.value]
	})
}
function segment(key: string): void {
	if (
		!key ||
		key.length > 256 ||
		key.includes('\0') ||
		['__proto__', 'prototype', 'constructor'].includes(key)
	)
		fail('[host] Input binding contains an invalid field or record key')
}
function unwrap(input: InputSchema): InputSchema & Record<string, unknown> {
	let current = input as InputSchema & Record<string, unknown>
	const seen = new Set<unknown>()
	while (!seen.has(current)) {
		seen.add(current)
		if (Array.isArray(current.pipe) && current.pipe[0] !== current) {
			current = schema(current.pipe[0], 'Vault record schema') as typeof current
			continue
		}
		if (current.wrapped) {
			current = schema(current.wrapped, 'Vault record schema') as typeof current
			continue
		}
		break
	}
	return current
}
export function vaultRecordSchema(declared: StandardSchemaV1, key: string): InputSchema {
	segment(key)
	const root = unwrap(schema(declared, 'Vault binding schema'))
	if (root.type === 'record') return schema(root.value, 'Vault record value')
	if (record(root.entries) && Object.hasOwn(root.entries, key))
		return schema(root.entries[key], 'Vault record value')
	return fail('[host] Vault binding key is not declared by the Vault binding schema')
}
function leaves(
	value: unknown,
	path: readonly string[] = [],
): { name: string; path: readonly string[] }[] {
	if (typeof value === 'string') {
		if (!/^[A-Z_][A-Z0-9_]*$/.test(value))
			fail('[host] Environment names must match [A-Z_][A-Z0-9_]*')
		return [{ name: value, path }]
	}
	if (!record(value) || Reflect.ownKeys(value).length === 0)
		fail('[host] An input mapping must be a name or non-empty object tree')
	return Reflect.ownKeys(value).flatMap((key) => {
		if (typeof key !== 'string') return fail('[host] Input mapping keys must be strings')
		segment(key)
		const property = Object.getOwnPropertyDescriptor(value, key)!
		if (!property.enumerable || !('value' in property))
			return fail('[host] Input mappings must contain data properties')
		return leaves(property.value, [...path, key])
	})
}
function setPath(target: Record<string, unknown>, path: readonly string[], value: unknown): void {
	let cursor = target
	for (const key of path.slice(0, -1)) {
		if (!record(cursor[key])) cursor[key] = Object.create(null)
		cursor = cursor[key] as Record<string, unknown>
	}
	cursor[path.at(-1)!] = value
}
function decode(
	inputSchema: InputSchema,
	mapping: ReturnType<typeof leaves>,
	environment: HostStartupContext['env'],
	required: boolean,
): { value: unknown; sources: Source[] } {
	let value: unknown = Object.create(null)
	const sources: Source[] = []
	for (const leaf of mapping) {
		const projection = projectRawInput(inputSchema as unknown as Schema, leaf.path)
		if (!projection.ok)
			fail(`[host] Unsupported input binding ${leaf.name} at ${leaf.path.join('.') || '<root>'}`)
		const raw = environment[leaf.name]
		if (raw === undefined) {
			if (required)
				throw new InputBindingError(
					'MISSING_INPUT',
					`[host] Required deployment input ${leaf.name} is missing`,
				)
			continue
		}
		let decoded: unknown
		try {
			if (typeof raw !== 'string') throw new Error('Invalid declared input')
			decoded = projection.transport === 'string' ? raw : JSON.parse(raw)
			if (
				projection.transport === 'number' &&
				(typeof decoded !== 'number' || !Number.isFinite(decoded))
			)
				throw new Error('Invalid declared input')
			if (projection.transport === 'boolean' && typeof decoded !== 'boolean')
				throw new Error('Invalid declared input')
			if (projection.expectsPlainObject && !record(decoded))
				throw new Error('Invalid declared input')
		} catch {
			throw new InputBindingError(
				'INVALID_INPUT',
				`[host] Deployment input ${leaf.name} does not match its declared transport`,
			)
		}
		if (leaf.path.length === 0) value = decoded
		else setPath(value as Record<string, unknown>, leaf.path, decoded)
		sources.push({ path: leaf.path, kind: 'env', name: leaf.name })
	}
	return { value, sources }
}
async function validateVault(
	declared: StandardSchemaV1,
	key: string,
	value: unknown,
): Promise<unknown> {
	const root = unwrap(schema(declared, 'Vault binding schema'))
	try {
		if (root.type === 'record' && root.key) {
			const result = await schema(root.key, 'Vault record key')['~standard'].validate(key)
			if (result.issues || !('value' in result)) throw new Error('Invalid declared input')
		}
		const result = await vaultRecordSchema(declared, key)['~standard'].validate(value)
		if (result.issues || !('value' in result)) throw new Error('Invalid declared input')
		return result.value
	} catch {
		throw new InputBindingError(
			'INVALID_INPUT',
			`[host] Deployment Vault record ${key} failed schema validation`,
		)
	}
}
async function readJson(path: string, root: string): Promise<unknown> {
	if (typeof path !== 'string' || !path || path.includes('\0'))
		fail('[host] File binding must name a JSON file')
	try {
		const [{ readFile }, { resolve }] = await Promise.all([
			import('node:fs/promises'),
			import('node:path'),
		])
		return JSON.parse(await readFile(resolve(root, path), 'utf8')) as unknown
	} catch {
		throw new InputBindingError('FILE_READ_FAILED', '[host] Cannot read a declared JSON input file')
	}
}
/** Evaluate explicitly declared sources only. Errors never include decoded values. */
export async function resolveInputBindings(
	application: HostApplication,
	startup: HostStartupContext,
): Promise<ResolvedInputBindings> {
	const records: PluginConfigRecordSnapshot[] = []
	const declarationSources: ResolvedInputBindings['declarationSources'][number][] = []
	const overlays: ResolvedInputBindings['overlays'][number][] = []
	const vaultBindings: HostVaultBindingRecord[] = []
	const seen = new Set<string>()
	const bindings: ConfigBindingProof[] = []
	const configTargets = new Map<string, (readonly string[])[]>()
	const target = (
		plugin: PluginConstructor | PluginNodeAddress,
		kind: string,
		namespace = '',
		key = '',
	) => {
		const owner = parsePluginNodeAddress(
			typeof plugin === 'function' ? plugin.nodeAddress() : plugin,
		)
		const identity = JSON.stringify([pluginNodeIndexKey(owner), kind, namespace, key])
		if (seen.has(identity)) fail('[host] An input target cannot have multiple source bindings')
		seen.add(identity)
		return owner
	}
	const checkPaths = (
		owner: PluginNodeAddress,
		layer: string,
		paths: readonly (readonly string[])[],
	) => {
		const key = `${pluginNodeIndexKey(owner)}:${layer}`
		const previous = configTargets.get(key) ?? []
		for (const path of paths) {
			if (previous.some((other) => configPathsOverlap(other, path)))
				fail('[host] A config source layer contains overlapping binding paths')
			previous.push(path)
		}
		configTargets.set(key, previous)
	}
	for (const binding of [...(application.fileBindings ?? []), ...(application.envBindings ?? [])]) {
		if (!record(binding)) fail('[host] Input bindings must be plain objects')
		for (const key of Reflect.ownKeys(binding)) {
			if (typeof key !== 'string' || !['plugin', 'config', 'vault'].includes(key))
				fail('[host] Unsupported input binding field')
			const property = Object.getOwnPropertyDescriptor(binding, key)!
			if (!property.enumerable || !('value' in property))
				fail('[host] Bindings must contain data properties')
		}

		if (binding.vault !== undefined && !record(binding.vault))
			fail('[host] Vault bindings must be record mappings')
		if (binding.config === undefined && binding.vault === undefined)
			fail('[host] Input binding has no target')
	}
	// Capture declaration data before file IO or async schema validation can yield to its owner.
	// Schemas keep their identity; validated mapping leaves no longer borrow the caller's tree.
	const fileBindings = (application.fileBindings ?? []).map((binding) => {
		if (binding.config !== undefined)
			envelope(binding.config, ['schema', 'path'], 'Config file binding')
		if (binding.vault !== undefined) {
			envelope(binding.vault, ['schema', 'paths', 'namespace'], 'Vault file binding')
			validateNamespace(binding.vault.namespace)
			if (!record(binding.vault.paths) || Reflect.ownKeys(binding.vault.paths).length === 0)
				fail('[host] Vault file paths must enumerate at least one record')
			schema(binding.vault.schema, 'Vault binding schema')
		}
		return {
			plugin:
				typeof binding.plugin === 'function'
					? binding.plugin
					: parsePluginNodeAddress(binding.plugin),
			config: binding.config && { ...binding.config },
			vault: binding.vault && {
				schema: binding.vault.schema,
				namespace: binding.vault.namespace,
				paths: dataEntries(binding.vault.paths, 'Vault file paths'),
			},
		}
	})
	const envBindings = (application.envBindings ?? []).map((binding) => {
		if (binding.config !== undefined)
			envelope(binding.config, ['schema', 'mapping'], 'Config environment binding')
		if (binding.vault !== undefined) {
			envelope(binding.vault, ['schema', 'mapping', 'namespace'], 'Vault environment binding')
			validateNamespace(binding.vault.namespace)
			if (!record(binding.vault.mapping) || Reflect.ownKeys(binding.vault.mapping).length === 0)
				fail('[host] Vault mapping must enumerate at least one record')
			schema(binding.vault.schema, 'Vault binding schema')
		}
		return {
			plugin:
				typeof binding.plugin === 'function'
					? binding.plugin
					: parsePluginNodeAddress(binding.plugin),
			config: binding.config && {
				schema: binding.config.schema,
				mapping: leaves(binding.config.mapping),
			},
			vault: binding.vault && {
				schema: binding.vault.schema,
				namespace: binding.vault.namespace,
				mapping: dataEntries(binding.vault.mapping, 'Vault record mappings').map(
					([key, mapping]) => {
						if (mapping === undefined) fail('[host] Vault environment bindings must name inputs')
						return [key, leaves(mapping)] as const
					},
				),
			},
		}
	})
	for (const binding of fileBindings) {
		if (binding.config !== undefined) {
			configSchema(
				binding.plugin,
				schema(binding.config.schema, 'Config binding schema'),
				application.plugins,
			)
			const owner = parsePluginNodeAddress(
				typeof binding.plugin === 'function' ? binding.plugin.nodeAddress() : binding.plugin,
			)
			const value = await readJson(binding.config.path, startup.root)
			if (!record(value))
				throw new InputBindingError('INVALID_INPUT', '[host] A config file must contain an object')
			const config = snapshotConfigInput(value)
			const paths = configLeafPaths(config)
			checkPaths(owner, 'file', paths)
			bindings.push(
				configBindingProof(binding.plugin, binding.config.schema, [[]], application.plugins),
			)
			records.push({ owner, config })
			for (const path of paths)
				declarationSources.push({ owner, path, kind: 'file', name: binding.config.path })
		}
		for (const [key, path] of binding.vault?.paths ?? []) {
			const owner = target(binding.plugin, 'vault', binding.vault?.namespace, key)
			if (typeof path !== 'string') fail('[host] Vault file bindings must name JSON files')
			const declared = binding.vault!.schema
			const raw = await readJson(path, startup.root)
			const entry: HostVaultBindingRecord = {
				owner,
				key,
				namespace: binding.vault?.namespace,
				source: 'file',
				value: await validateVault(declared, key, raw),
			}
			vaultBindings.push(entry)
		}
	}
	for (const binding of envBindings) {
		if (binding.config !== undefined) {
			const owner = parsePluginNodeAddress(
				typeof binding.plugin === 'function' ? binding.plugin.nodeAddress() : binding.plugin,
			)
			checkPaths(
				owner,
				'env',
				binding.config.mapping.map((leaf) => leaf.path),
			)
			bindings.push(
				configBindingProof(
					binding.plugin,
					binding.config.schema,
					binding.config.mapping.map((leaf) => leaf.path),
					application.plugins,
				),
			)
			const decoded = decode(
				configSchema(
					binding.plugin,
					schema(binding.config.schema, 'Config binding schema'),
					application.plugins,
				),
				binding.config.mapping,
				startup.env,
				false,
			)
			if (!record(decoded.value))
				throw new InputBindingError(
					'INVALID_INPUT',
					'[host] A config environment binding must produce an object',
				)
			if (decoded.sources.length > 0) {
				const overlay = {
					owner,
					config: snapshotConfigInput(decoded.value),
					sources: decoded.sources,
				}
				overlays.push(overlay)
			}
		}
		for (const [key, mapping] of binding.vault?.mapping ?? []) {
			const owner = target(binding.plugin, 'vault', binding.vault?.namespace, key)
			const declared = binding.vault!.schema
			const decoded = decode(vaultRecordSchema(declared, key), mapping, startup.env, true)
			const entry: HostVaultBindingRecord = {
				owner,
				key,
				namespace: binding.vault?.namespace,
				source: 'env',
				value: await validateVault(declared, key, decoded.value),
			}
			vaultBindings.push(entry)
		}
	}
	return { records, declarationSources, overlays, vaultBindings, bindings }
}

export { InputBindingError } from './input-binding-contract'
