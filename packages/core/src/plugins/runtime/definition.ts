import type { StandardSchemaV1 } from '@standard-schema/spec'
import { isStandardSchemaV1 } from '../../services/config/standardSchema'
import type { PluginConstructor, PluginIdentifier } from '../types'
import {
	createPluginNodeAddress,
	parsePluginDefinitionAddress,
	type PluginDefinitionAddressSnapshot,
	type PluginNodeAddressSnapshot,
} from './identity'
import { getForkId } from './fork-identity'

export type PluginDefinitionKind = 'plugin' | 'abstract'

export type PluginDefinitionFacts = Readonly<{
	readonly kind: PluginDefinitionKind
	readonly definition: PluginDefinitionAddressSnapshot
	/** Ordered by constructor parameter index. */
	readonly requires: readonly PluginDefinitionAddressSnapshot[]
	/** Static optional restart edges declared by direct init-time plugins.use() calls. */
	readonly optional: readonly PluginDefinitionAddressSnapshot[]
	/** Explicit abstract provider relation from @Plugin(AbstractToken). */
	readonly provides?: PluginDefinitionAddressSnapshot
}>

export type PluginConfigDefinition = Readonly<{
	readonly fieldName: string
	readonly schema: StandardSchemaV1
	readonly source?: string
}>

const factsByConstructor = new WeakMap<PluginIdentifier, PluginDefinitionFacts>()
const configByConstructor = new WeakMap<PluginConstructor, PluginConfigDefinition>()

function nonEmpty(value: unknown, label: string): string {
	if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
		throw new TypeError(
			`[pluxel/core] ${label} must be a non-empty string without surrounding whitespace`,
		)
	}
	return value
}

function normalizeAddresses(
	input: readonly PluginDefinitionAddressSnapshot[] | undefined,
	label: string,
): readonly PluginDefinitionAddressSnapshot[] {
	if (input === undefined) return Object.freeze([])
	if (!Array.isArray(input)) throw new TypeError(`[pluxel/core] ${label} must be an array`)
	return Object.freeze(input.map((address) => parsePluginDefinitionAddress(address)))
}

export function __setPluginDefinition(
	ctor: PluginIdentifier,
	input: {
		readonly kind: PluginDefinitionKind
		readonly definition: PluginDefinitionAddressSnapshot
		readonly requires?: readonly PluginDefinitionAddressSnapshot[]
		readonly optional?: readonly PluginDefinitionAddressSnapshot[]
		readonly provides?: PluginDefinitionAddressSnapshot
	},
): void {
	if (typeof ctor !== 'function')
		throw new TypeError('[pluxel/core] Plugin definition target must be a constructor')
	if (input.kind !== 'plugin' && input.kind !== 'abstract') {
		throw new TypeError('[pluxel/core] Plugin definition kind must be plugin or abstract')
	}
	const facts: PluginDefinitionFacts = Object.freeze({
		kind: input.kind,
		definition: parsePluginDefinitionAddress(input.definition),
		requires: normalizeAddresses(input.requires, 'Plugin required definition facts'),
		optional: normalizeAddresses(input.optional, 'Plugin optional definition facts'),
		...(input.provides === undefined
			? {}
			: { provides: parsePluginDefinitionAddress(input.provides) }),
	})
	if (
		facts.kind === 'abstract' &&
		(facts.requires.length > 0 || facts.optional.length > 0 || facts.provides)
	) {
		throw new TypeError('[pluxel/core] Abstract Plugin definition facts cannot declare edges')
	}
	const previous = factsByConstructor.get(ctor)
	if (previous && previous !== facts) {
		throw new Error('[pluxel/core] Plugin constructor already has definition facts')
	}
	factsByConstructor.set(ctor, facts)
}

export function getPluginDefinitionFacts(ctor: PluginIdentifier): PluginDefinitionFacts {
	const facts = factsByConstructor.get(ctor)
	if (!facts) {
		const name = (ctor as { readonly name?: string }).name || '<anonymous>'
		throw new Error(
			`[pluxel/core] Plugin definition was not lowered for ${name}. Load Plugin source through the Pluxel Vite/Rolldown semantic pass.`,
		)
	}
	return facts
}

export function hasPluginDefinitionFacts(ctor: PluginIdentifier): boolean {
	return factsByConstructor.has(ctor)
}

/** Host/route projection from a lowered implementation generation to its durable node address. */
export function pluginNodeAddressOf(ctor: PluginConstructor): PluginNodeAddressSnapshot {
	const definition = getPluginDefinitionFacts(ctor).definition
	const forkId = getForkId(ctor)
	return createPluginNodeAddress(
		forkId ? { definition, instance: 'fork', forkId } : { definition, instance: 'default' },
	)
}

export function clonePluginDefinitionFacts(from: PluginIdentifier, to: PluginIdentifier): void {
	const facts = getPluginDefinitionFacts(from)
	factsByConstructor.set(to, facts)
	const config = configByConstructor.get(from as PluginConstructor)
	if (config) configByConstructor.set(to as PluginConstructor, config)
}

export function __setPluginConfig(
	ctor: PluginConstructor,
	input: {
		readonly fieldName: string
		readonly schema: StandardSchemaV1
		readonly source?: string
	},
): void {
	if (typeof ctor !== 'function')
		throw new TypeError('[pluxel/core] Plugin config target must be a constructor')
	const fieldName = nonEmpty(input.fieldName, 'Plugin config field name')
	if (!isStandardSchemaV1(input.schema)) {
		throw new TypeError('[pluxel/core] Plugin config must implement Standard Schema v1')
	}
	if (configByConstructor.has(ctor)) {
		throw new Error('[pluxel/core] A Plugin may declare exactly one object config schema')
	}
	configByConstructor.set(
		ctor,
		Object.freeze({
			fieldName,
			schema: input.schema,
			...(input.source === undefined ? {} : { source: String(input.source) }),
		}),
	)
}

export function getPluginConfigDefinition(
	ctor: PluginConstructor,
): PluginConfigDefinition | undefined {
	return configByConstructor.get(ctor)
}

const PLUGIN_REF = Symbol('PluginRef')

export type PluginRef<T> = Readonly<{
	readonly definition: PluginDefinitionAddressSnapshot
	readonly [PLUGIN_REF]: (_value: T) => T
}>

export function definePluginRef<T>(): PluginRef<T> {
	throw new Error(
		'[pluxel/core] Plugin ref was not lowered. definePluginRef<T>() must be a non-exported module-level const processed by the Pluxel semantic pass.',
	)
}

export function __definePluginRef<T>(definition: PluginDefinitionAddressSnapshot): PluginRef<T> {
	return Object.freeze({
		definition: parsePluginDefinitionAddress(definition),
		[PLUGIN_REF]: ((value: T) => value) as (_value: T) => T,
	})
}

export function isPluginRef(value: unknown): value is PluginRef<unknown> {
	return !!value && typeof value === 'object' && PLUGIN_REF in value
}
