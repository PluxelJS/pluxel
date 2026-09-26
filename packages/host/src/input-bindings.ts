import {
	pluginNodeAddressOf,
	pluginNodeIndexKey,
	type PluginConstructor,
	type PluginNodeAddress,
} from '@pluxel/core'
import { consumePluginDefinitionCandidate } from '@pluxel/core/internal'
import type { PluginConfigRecordSnapshot } from '@pluxel/core/services'
import type { StandardSchemaV1 } from '@standard-schema/spec'
import { projectRawInput, type Schema } from 'valibot-form'
import type { HostApplication, HostRuntimeOptions } from './host'
import type { HostStartupContext } from './application'
import type { HostVaultBindingRecord } from './bindings'

export class InputBindingError extends Error {
	constructor(
		readonly code: 'INVALID_BINDING' | 'MISSING_INPUT' | 'INVALID_INPUT' | 'FILE_READ_FAILED',
		message: string,
	) {
		super(message)
		this.name = 'InputBindingError'
	}
}

type InputSchema = StandardSchemaV1 & { readonly kind: 'schema'; readonly type: string }
const declaredConfigBindings = new WeakSet<object>()

type Source = Readonly<{ path: readonly string[]; kind: 'env'; name: string }>
export type ResolvedInputBindings = Readonly<{
	base: readonly PluginConfigRecordSnapshot[]
	baseSources: readonly {
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

function fail(message: string): never {
	throw new InputBindingError('INVALID_BINDING', message)
}
function record(value: unknown): value is Record<string, unknown> {
	return (
		!!value &&
		typeof value === 'object' &&
		(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
	)
}
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
function schema(value: unknown, label: string): InputSchema {
	if (
		!record(value) ||
		value.kind !== 'schema' ||
		!record(value['~standard']) ||
		typeof value['~standard'].validate !== 'function'
	)
		fail(`[host] ${label} must declare a Valibot schema`)
	return value as unknown as InputSchema
}
function configSchema(plugin: PluginConstructor, selected?: StandardSchemaV1): InputSchema {
	const candidate = consumePluginDefinitionCandidate(plugin)
	const declared = schema(candidate.declaration.config?.owner?.schema, 'configs.use()')
	if (selected !== undefined && declared !== selected)
		fail('[host] Config binding must reference the same schema as configs.use()')
	return declared
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
	mapping: unknown,
	environment: HostStartupContext['env'],
	required: boolean,
): { value: unknown; sources: Source[] } {
	let value: unknown = Object.create(null)
	const sources: Source[] = []
	for (const leaf of leaves(mapping)) {
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
	const base: PluginConfigRecordSnapshot[] = []
	const baseSources: ResolvedInputBindings['baseSources'][number][] = []
	const overlays: ResolvedInputBindings['overlays'][number][] = []
	const vaultBindings: HostVaultBindingRecord[] = []
	const seen = new Set<string>()
	const target = (plugin: PluginConstructor, kind: string, namespace = '', key = '') => {
		if (typeof plugin !== 'function')
			fail('[host] Input bindings require an explicit Plugin constructor')
		const owner = pluginNodeAddressOf(plugin)
		const identity = JSON.stringify([pluginNodeIndexKey(owner), kind, namespace, key])
		if (seen.has(identity)) fail('[host] An input target cannot have multiple source bindings')
		seen.add(identity)
		return owner
	}
	for (const binding of [...(application.fileBindings ?? []), ...(application.envBindings ?? [])]) {
		if (!record(binding)) fail('[host] Input bindings must be plain objects')
		for (const key of Reflect.ownKeys(binding)) {
			if (typeof key !== 'string' || !['plugin', 'namespace', 'config', 'vault'].includes(key))
				fail('[host] Unsupported input binding field')
			const property = Object.getOwnPropertyDescriptor(binding, key)!
			if (!property.enumerable || !('value' in property))
				fail('[host] Bindings must contain data properties')
		}
		if (
			binding.namespace !== undefined &&
			(typeof binding.namespace !== 'string' ||
				!binding.namespace ||
				binding.namespace.includes('\0'))
		)
			fail('[host] Invalid Vault namespace')
		if (binding.vault !== undefined && !record(binding.vault))
			fail('[host] Vault bindings must be record mappings')
		if (binding.config === undefined && binding.vault === undefined)
			fail('[host] Input binding has no target')
	}
	for (const binding of application.fileBindings ?? []) {
		if (binding.config !== undefined)
			envelope(binding.config, ['schema', 'path'], 'Config file binding')
		if (binding.vault !== undefined) {
			envelope(binding.vault, ['schema', 'paths'], 'Vault file binding')
			if (!record(binding.vault.paths) || Reflect.ownKeys(binding.vault.paths).length === 0)
				fail('[host] Vault file paths must enumerate at least one record')
			schema(binding.vault.schema, 'Vault binding schema')
		}
		if (binding.config !== undefined) {
			configSchema(binding.plugin, schema(binding.config.schema, 'Config binding schema'))
			const owner = target(binding.plugin, 'config-file')
			const value = await readJson(binding.config.path, startup.root)
			if (!record(value))
				throw new InputBindingError('INVALID_INPUT', '[host] A config file must contain an object')
			base.push({ owner, config: value })
			const fileSource: ResolvedInputBindings['baseSources'][number] = {
				owner,
				path: [],
				kind: 'file',
				name: binding.config.path,
			}
			declaredConfigBindings.add(fileSource)
			baseSources.push(fileSource)
		}
		for (const [key, path] of dataEntries(binding.vault?.paths ?? {}, 'Vault file paths')) {
			const owner = target(binding.plugin, 'vault', binding.namespace, key)
			if (typeof path !== 'string') fail('[host] Vault file bindings must name JSON files')
			const declared = binding.vault!.schema
			const raw = await readJson(path, startup.root)
			const entry: HostVaultBindingRecord = {
				owner,
				key,
				namespace: binding.namespace,
				source: 'file',
				value: await validateVault(declared, key, raw),
			}
			vaultBindings.push(entry)
		}
	}
	for (const binding of application.envBindings ?? []) {
		if (binding.config !== undefined)
			envelope(binding.config, ['schema', 'mapping'], 'Config environment binding')
		if (binding.vault !== undefined) {
			envelope(binding.vault, ['schema', 'mapping'], 'Vault environment binding')
			if (!record(binding.vault.mapping) || Reflect.ownKeys(binding.vault.mapping).length === 0)
				fail('[host] Vault mapping must enumerate at least one record')
			schema(binding.vault.schema, 'Vault binding schema')
		}
		if (binding.config !== undefined) {
			const owner = target(binding.plugin, 'config-env')
			const decoded = decode(
				configSchema(binding.plugin, schema(binding.config.schema, 'Config binding schema')),
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
				const overlay = { owner, config: decoded.value, sources: decoded.sources }
				declaredConfigBindings.add(overlay)
				overlays.push(overlay)
			}
		}
		for (const [key, mapping] of dataEntries(
			binding.vault?.mapping ?? {},
			'Vault record mappings',
		)) {
			const owner = target(binding.plugin, 'vault', binding.namespace, key)
			if (mapping === undefined) fail('[host] Vault environment bindings must name inputs')
			const declared = binding.vault!.schema
			const decoded = decode(vaultRecordSchema(declared, key), mapping, startup.env, true)
			const entry: HostVaultBindingRecord = {
				owner,
				key,
				namespace: binding.namespace,
				source: 'env',
				value: await validateVault(declared, key, decoded.value),
			}
			vaultBindings.push(entry)
		}
	}
	return { base, baseSources, overlays, vaultBindings }
}

/** Recheck config deployment paths against replacement metadata. Vault contracts belong to the Host binding. */
export async function validateInputBindingCandidates(
	plugins: readonly PluginConstructor[],
	options: HostRuntimeOptions,
): Promise<void> {
	for (const plugin of plugins) {
		const owner = pluginNodeIndexKey(pluginNodeAddressOf(plugin))
		const overlays =
			options.configRecords?.overlays?.filter(
				(entry) => declaredConfigBindings.has(entry) && pluginNodeIndexKey(entry.owner) === owner,
			) ?? []
		const files =
			options.configRecords?.baseSources?.filter(
				(entry) => declaredConfigBindings.has(entry) && pluginNodeIndexKey(entry.owner) === owner,
			) ?? []
		if (overlays.length > 0 || files.length > 0) {
			const declared = configSchema(plugin)
			for (const overlay of overlays)
				for (const source of overlay.sources) {
					if (!projectRawInput(declared as unknown as Schema, source.path).ok)
						fail('[host] Replacement config schema is incompatible with deployment bindings')
				}
		}
	}
}
