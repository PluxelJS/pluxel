import {
	formatPluginNodeReference,
	pluginNodeIndexKey,
	type PluginConstructor,
	type PluginNodeAddress,
} from '@pluxel/core'
import { consumePluginDefinitionCandidate } from '@pluxel/core/internal'
import type { PluginConfigRecordSnapshot } from '@pluxel/core/services'
import type { StandardSchemaV1 } from '@standard-schema/spec'
import { projectRawInput, type RawInputProjectionResult, type Schema } from 'valibot-form'
import type {
	ConfigEnvironmentBinding,
	ConfigEnvironmentMapping,
	ConfigEnvironmentSchema,
	StaticRuntimeApplication,
	StaticRuntimeEnvironment,
} from './types.ts'

const CONFIG_ENVIRONMENT_BINDING = Symbol.for('pluxel.staticConfigEnvironmentBinding')
const ENVIRONMENT_NAME = /^[A-Z_][A-Z0-9_]*$/
const RESERVED_ENVIRONMENT_PREFIX = 'PLUXEL_'

type FrozenMapping = string | FrozenMappingObject

type FrozenMappingObject = Readonly<{
	readonly [key: string]: FrozenMapping
}>

type ConfigEnvironmentBindingPayload = Readonly<{
	abiVersion: 1
	plugin: PluginConstructor
	schema: ConfigEnvironmentSchema
	mapping: FrozenMapping
	/** Added without changing ABI; older HMR generations are projected lazily. */
	targets?: readonly ProjectedMappingTarget[]
}>

type RuntimeBinding = Readonly<{
	readonly [CONFIG_ENVIRONMENT_BINDING]: ConfigEnvironmentBindingPayload
}>

type DerivedTransport = 'string' | 'number' | 'boolean' | 'json'

type ProjectedMappingTarget = Readonly<{
	environmentName: string
	path: readonly string[]
	projection: RawInputProjectionResult
}>

type ResolvedTarget = Readonly<{
	environmentName: string
	owner: PluginNodeAddress
	path: readonly string[]
	transport: DerivedTransport
	expectsPlainObject: boolean
}>

/** Bind environment names to the raw input tree of the exact schema used by one fixed Plugin. */
export function bindConfigEnvironment<
	TPlugin extends PluginConstructor,
	TSchema extends ConfigEnvironmentSchema,
>(
	plugin: TPlugin,
	schema: TSchema,
	mapping: ConfigEnvironmentMapping<StandardSchemaV1.InferInput<TSchema>>,
): ConfigEnvironmentBinding {
	if (typeof plugin !== 'function') {
		throw new TypeError('[runtime-static] Config environment binding Plugin must be a constructor')
	}
	if (!isConfigEnvironmentSchema(schema)) {
		throw new TypeError(
			'[runtime-static] Config environment binding schema must be a Valibot schema',
		)
	}
	const frozenMapping = freezeMapping(mapping)
	const targets = projectMappingTargets(schema, frozenMapping)
	const payload = Object.freeze({
		abiVersion: 1 as const,
		plugin,
		schema,
		mapping: frozenMapping,
		targets,
	})
	const binding = Object.create(null) as RuntimeBinding
	Object.defineProperty(binding, CONFIG_ENVIRONMENT_BINDING, {
		value: payload,
		enumerable: false,
		configurable: false,
		writable: false,
	})
	return Object.freeze(binding) as unknown as ConfigEnvironmentBinding
}

/** @internal Resolve and decode bootstrap declarations before the Runtime host graph is created. */
export function resolveConfigEnvironmentBootstrap(
	application: Pick<StaticRuntimeApplication, 'plugins' | 'configEnvironmentBootstrap'>,
	environment: StaticRuntimeEnvironment,
): PluginConfigRecordSnapshot[] {
	const declarations = application.configEnvironmentBootstrap ?? []
	if (declarations.length === 0) return []
	const catalogImplementations = new Set(application.plugins)
	const boundImplementations = new Set<PluginConstructor>()
	const targets: ResolvedTarget[] = []

	for (const declaration of declarations) {
		const binding = readBinding(declaration)
		if (!catalogImplementations.has(binding.plugin)) {
			throw new Error(
				'[runtime-static] Config environment binding targets a Plugin outside the static application catalog',
			)
		}
		if (boundImplementations.has(binding.plugin)) {
			const candidate = consumePluginDefinitionCandidate(binding.plugin)
			throw new Error(
				`[runtime-static] Duplicate config environment binding for ${formatPluginNodeReference({ definition: candidate.declaration.address, variant: 'default' })}`,
			)
		}
		boundImplementations.add(binding.plugin)

		const candidate = consumePluginDefinitionCandidate(binding.plugin)
		const owner: PluginNodeAddress = Object.freeze({
			definition: candidate.declaration.address,
			variant: 'default',
		})
		const declaredSchema = candidate.declaration.config?.owner?.schema
		if (declaredSchema !== binding.schema) {
			throw new Error(
				`[runtime-static] Config environment binding schema does not match the root config schema declared by ${formatPluginNodeReference(owner)}`,
			)
		}

		const projectedTargets =
			binding.targets ?? projectMappingTargets(binding.schema, binding.mapping)
		for (const target of projectedTargets) {
			const projection = target.projection
			if (projection.ok === false) {
				throw new Error(
					`[runtime-static] Cannot bind ${target.environmentName} to ${formatPluginNodeReference(owner)} config path ${formatPath(target.path)}: ${projection.reason}`,
				)
			}
			targets.push(
				Object.freeze({
					environmentName: target.environmentName,
					owner,
					path: target.path,
					transport: projection.transport,
					expectsPlainObject: projection.expectsPlainObject,
				}),
			)
		}
	}

	return decodeTargets(targets, environment)
}

function readBinding(value: ConfigEnvironmentBinding): ConfigEnvironmentBindingPayload {
	if (!value || typeof value !== 'object') {
		throw new TypeError(
			'[runtime-static] configEnvironmentBootstrap entries must be created with bindConfigEnvironment(...)',
		)
	}
	const descriptor = Object.getOwnPropertyDescriptor(value, CONFIG_ENVIRONMENT_BINDING)
	const payload = descriptor?.value as ConfigEnvironmentBindingPayload | undefined
	if (
		!payload ||
		payload.abiVersion !== 1 ||
		typeof payload.plugin !== 'function' ||
		!isConfigEnvironmentSchema(payload.schema) ||
		(payload.targets !== undefined && !Array.isArray(payload.targets))
	) {
		throw new TypeError(
			'[runtime-static] configEnvironmentBootstrap entries must be created with bindConfigEnvironment(...)',
		)
	}
	return payload
}

function isConfigEnvironmentSchema(value: unknown): value is ConfigEnvironmentSchema {
	return Boolean(
		value &&
		typeof value === 'object' &&
		(value as { kind?: unknown }).kind === 'schema' &&
		typeof (value as { type?: unknown }).type === 'string' &&
		'~standard' in value,
	)
}

function freezeMapping(value: unknown, path: readonly string[] = []): FrozenMapping {
	if (typeof value === 'string') {
		assertEnvironmentName(value, path)
		return value
	}
	if (!isPlainRecord(value)) {
		throw new TypeError(
			`[runtime-static] Config environment mapping at ${formatPath(path)} must be an environment name or object tree`,
		)
	}
	const keys = Reflect.ownKeys(value)
	if (keys.length === 0) {
		throw new Error(
			`[runtime-static] Config environment mapping at ${formatPath(path)} must contain at least one binding`,
		)
	}
	const mapping: Record<string, FrozenMapping> = Object.create(null)
	for (const key of keys) {
		if (typeof key !== 'string') {
			throw new TypeError('[runtime-static] Config environment mapping keys must be strings')
		}
		const descriptor = Object.getOwnPropertyDescriptor(value, key)
		if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
			throw new TypeError(
				`[runtime-static] Config environment mapping at ${formatPath([...path, key])} must use enumerable data properties`,
			)
		}
		mapping[key] = freezeMapping(descriptor.value, [...path, key])
	}
	return Object.freeze(mapping)
}

function assertEnvironmentName(value: string, path: readonly string[]): void {
	if (!ENVIRONMENT_NAME.test(value)) {
		throw new Error(
			`[runtime-static] Config environment name at ${formatPath(path)} must match [A-Z_][A-Z0-9_]*`,
		)
	}
	if (value.startsWith(RESERVED_ENVIRONMENT_PREFIX)) {
		throw new Error(
			`[runtime-static] Config environment name ${value} is reserved for the Pluxel framework`,
		)
	}
}

function collectMappingLeaves(
	mapping: FrozenMapping,
	path: readonly string[] = [],
): ReadonlyArray<Readonly<{ environmentName: string; path: readonly string[] }>> {
	if (typeof mapping === 'string') {
		return [Object.freeze({ environmentName: mapping, path: Object.freeze([...path]) })]
	}
	return Object.entries(mapping).flatMap(([key, child]) =>
		collectMappingLeaves(child, [...path, key]),
	)
}

function projectMappingTargets(
	schema: ConfigEnvironmentSchema,
	mapping: FrozenMapping,
): readonly ProjectedMappingTarget[] {
	return Object.freeze(
		collectMappingLeaves(mapping).map((leaf) =>
			Object.freeze({
				...leaf,
				projection: projectRawInput(schema as unknown as Schema, leaf.path),
			}),
		),
	)
}

function decodeTargets(
	targets: readonly ResolvedTarget[],
	environment: StaticRuntimeEnvironment,
): PluginConfigRecordSnapshot[] {
	const byEnvironment = new Map<
		string,
		Readonly<{ transport: DerivedTransport; targets: ResolvedTarget[] }>
	>()
	for (const target of targets) {
		const previous = byEnvironment.get(target.environmentName)
		if (previous && previous.transport !== target.transport) {
			throw new Error(
				`[runtime-static] Config environment ${target.environmentName} has conflicting derived transports ${previous.transport} and ${target.transport}`,
			)
		}
		if (previous) previous.targets.push(target)
		else {
			byEnvironment.set(target.environmentName, {
				transport: target.transport,
				targets: [target],
			})
		}
	}

	const byOwner = new Map<string, PluginConfigRecordSnapshot>()
	for (const environmentName of [...byEnvironment.keys()].sort()) {
		const value = environment[environmentName]
		if (value === undefined) continue
		const group = byEnvironment.get(environmentName)!
		if (typeof value !== 'string') throw transportDecodeError(environmentName, group.transport)
		const decoded = decodeEnvironmentValue(environmentName, value, group.transport)
		for (const target of group.targets) {
			if ((target.path.length === 0 || target.expectsPlainObject) && !isPlainRecord(decoded)) {
				throw new Error(
					`[runtime-static] Config environment ${environmentName} must decode to a plain object for ${formatPluginNodeReference(target.owner)} config path ${formatPath(target.path)}`,
				)
			}
			const ownerKey = pluginNodeIndexKey(target.owner)
			let record = byOwner.get(ownerKey)
			if (!record) {
				record = { owner: target.owner, config: Object.create(null) as Record<string, unknown> }
				byOwner.set(ownerKey, record)
			}
			if (target.path.length === 0) {
				record = { owner: target.owner, config: cloneRecord(decoded) }
				byOwner.set(ownerKey, record)
			} else {
				setConfigPath(record.config as Record<string, unknown>, target.path, clone(decoded))
			}
		}
	}
	return [...byOwner.values()].sort((left, right) =>
		pluginNodeIndexKey(left.owner).localeCompare(pluginNodeIndexKey(right.owner)),
	)
}

function decodeEnvironmentValue(
	environmentName: string,
	value: string,
	transport: DerivedTransport,
): unknown {
	if (transport === 'string') return value
	let decoded: unknown
	try {
		decoded = JSON.parse(value) as unknown
	} catch {
		throw transportDecodeError(environmentName, transport)
	}
	if (transport === 'number') {
		if (typeof decoded !== 'number' || !Number.isFinite(decoded)) {
			throw transportDecodeError(environmentName, transport)
		}
		return decoded
	}
	if (transport === 'boolean') {
		if (typeof decoded !== 'boolean') throw transportDecodeError(environmentName, transport)
		return decoded
	}
	return decoded
}

function transportDecodeError(environmentName: string, transport: DerivedTransport): Error {
	const expected =
		transport === 'number'
			? 'a finite JSON number'
			: transport === 'boolean'
				? 'JSON true or false'
				: 'JSON'
	return new Error(
		`[runtime-static] Config environment ${environmentName} must contain ${expected}`,
	)
}

function setConfigPath(
	record: Record<string, unknown>,
	path: readonly string[],
	value: unknown,
): void {
	let current = record
	for (let index = 0; index < path.length - 1; index++) {
		const segment = path[index]!
		const child = current[segment]
		if (isPlainRecord(child)) current = child as Record<string, unknown>
		else {
			const nested: Record<string, unknown> = Object.create(null)
			current[segment] = nested
			current = nested
		}
	}
	current[path.at(-1)!] = value
}

function cloneRecord(value: unknown): Record<string, unknown> {
	if (!isPlainRecord(value)) throw new TypeError('[runtime-static] Expected a plain config object')
	const cloned: Record<string, unknown> = Object.create(null)
	for (const [key, child] of Object.entries(value)) cloned[key] = clone(child)
	return cloned
}

function clone(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(clone)
	return isPlainRecord(value) ? cloneRecord(value) : value
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false
	const prototype = Object.getPrototypeOf(value)
	return prototype === Object.prototype || prototype === null
}

function formatPath(path: readonly string[]): string {
	return path.length === 0 ? '<root>' : path.join('.')
}
