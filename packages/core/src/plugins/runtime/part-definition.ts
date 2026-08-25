import type { StandardSchemaV1 } from '@standard-schema/spec'
import { isStandardSchemaV1 } from '../../services/config/standardSchema'
import {
	assertLoweringConstructor,
	invalidPluginDeclaration,
	parsePluginLoweringPayload,
	type PluginLoweringHeader,
} from './lowering-abi'
import {
	parsePluginDefinitionAddress,
	pluginDefinitionIndexKey,
	type PluginDefinitionAddress,
} from './identity'

export type PluginPartClass<T extends object = object> = Function & {
	readonly prototype: T
}

export type PartConfigDeclaration = Readonly<{
	readonly fieldName: string
	readonly schema: StandardSchemaV1
	readonly source?: string
}>

export type PluginPartDefinitionNode = Readonly<{
	readonly fieldName: string
	readonly Part: PluginPartClass
	readonly config?: PartConfigDeclaration
	/** Ordered by this Part constructor's parameter index. */
	readonly requires: readonly PluginDefinitionAddress[]
	readonly optional: readonly PluginDefinitionAddress[]
	readonly parts: PluginPartDefinitionTree
}>

export type PluginPartDefinitionTree = readonly PluginPartDefinitionNode[]

export type PluginPartsLoweringPayload = PluginLoweringHeader &
	Readonly<{
		readonly occurrences: readonly Readonly<{
			readonly fieldName: string
			readonly Part: PluginPartClass
		}>[]
	}>

export type PluginPartConfigLoweringPayload = PluginLoweringHeader & PartConfigDeclaration

export type PluginPartOptionalLoweringPayload = PluginLoweringHeader &
	Readonly<{ readonly optional: readonly PluginDefinitionAddress[] }>

export type PluginPartRequiresLoweringPayload = PluginLoweringHeader &
	Readonly<{ readonly requires: readonly PluginDefinitionAddress[] }>

type PluginPartOccurrence = Readonly<{
	readonly fieldName: string
	readonly Part: PluginPartClass
}>

const occurrencesByOwner = new WeakMap<Function, readonly PluginPartOccurrence[]>()
const configByPart = new WeakMap<Function, PartConfigDeclaration>()
const requiresByPart = new WeakMap<Function, readonly PluginDefinitionAddress[]>()
const optionalByPart = new WeakMap<Function, readonly PluginDefinitionAddress[]>()
const sealedOwners = new WeakSet<Function>()
const sealedParts = new WeakSet<Function>()
const EMPTY_OCCURRENCES: readonly PluginPartOccurrence[] = Object.freeze([])
const EMPTY_REQUIRES: readonly PluginDefinitionAddress[] = Object.freeze([])
const EMPTY_OPTIONAL: readonly PluginDefinitionAddress[] = Object.freeze([])

function nonEmpty(value: unknown, label: string): string {
	if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
		invalidPluginDeclaration(`[pluxel/core] ${label} must be a non-empty trimmed string`)
	}
	return value
}

function rejectSealed(target: Function, label: string, sealed: WeakSet<Function>): void {
	if (sealed.has(target)) {
		invalidPluginDeclaration(`[pluxel/core] ${label} facts cannot change after candidate ingestion`)
	}
}

/** @internal Build-generated Part containment facts. */
export function __setPluginParts(owner: Function, input: PluginPartsLoweringPayload): void {
	assertLoweringConstructor(owner, 'Part owner')
	rejectSealed(owner, 'PluginPart owner', sealedOwners)
	const payload = parsePluginLoweringPayload(input, 'Plugin Part facts', ['occurrences'])
	if (!Array.isArray(payload.occurrences)) {
		invalidPluginDeclaration('[pluxel/core] Plugin Part facts.occurrences must be an array')
	}
	if (occurrencesByOwner.has(owner)) {
		invalidPluginDeclaration('[pluxel/core] Part owner already has lowered occurrence facts')
	}
	const fields = new Set<string>()
	const occurrences = payload.occurrences.map((raw, index) => {
		if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
			invalidPluginDeclaration(
				`[pluxel/core] Plugin Part facts.occurrences[${index}] must be an object`,
			)
		}
		const item = raw as Record<string, unknown>
		for (const key of Object.keys(item)) {
			if (key !== 'fieldName' && key !== 'Part') {
				invalidPluginDeclaration(
					`[pluxel/core] Plugin Part facts.occurrences[${index}] has unknown field ${key}`,
				)
			}
		}
		const fieldName = nonEmpty(item.fieldName, `Plugin Part facts.occurrences[${index}].fieldName`)
		if (fields.has(fieldName)) {
			invalidPluginDeclaration(`[pluxel/core] Part owner declares duplicate field ${fieldName}`)
		}
		fields.add(fieldName)
		assertLoweringConstructor(item.Part, `Plugin Part facts.occurrences[${index}].Part`)
		return Object.freeze({ fieldName, Part: item.Part as PluginPartClass })
	})
	occurrencesByOwner.set(owner, Object.freeze(occurrences))
}

/** @internal Build-generated Part config declaration. */
export function __setPluginPartConfig(
	Part: Function,
	input: PluginPartConfigLoweringPayload,
): void {
	assertLoweringConstructor(Part, 'PluginPart config target')
	rejectSealed(Part, 'PluginPart config', sealedParts)
	const payload = parsePluginLoweringPayload(input, 'PluginPart config', [
		'fieldName',
		'schema',
		'source',
	])
	if (configByPart.has(Part)) {
		invalidPluginDeclaration('[pluxel/core] A PluginPart may declare one object config schema')
	}
	const fieldName = nonEmpty(payload.fieldName, 'PluginPart config field name')
	if (!isStandardSchemaV1(payload.schema)) {
		invalidPluginDeclaration('[pluxel/core] PluginPart config must implement Standard Schema v1')
	}
	const source = payload.source
	if (source !== undefined && typeof source !== 'string') {
		invalidPluginDeclaration('[pluxel/core] PluginPart config source must be a string')
	}
	configByPart.set(
		Part,
		Object.freeze({
			fieldName,
			schema: payload.schema,
			...(source === undefined ? {} : { source: source as string }),
		}),
	)
}

/** @internal Build-generated required Plugin edges declared by a Part constructor. */
export function __setPluginPartRequires(
	Part: Function,
	input: PluginPartRequiresLoweringPayload,
): void {
	assertLoweringConstructor(Part, 'PluginPart required target')
	rejectSealed(Part, 'PluginPart required', sealedParts)
	const payload = parsePluginLoweringPayload(input, 'PluginPart required facts', ['requires'])
	if (!Array.isArray(payload.requires)) {
		invalidPluginDeclaration('[pluxel/core] PluginPart required facts.requires must be an array')
	}
	if (requiresByPart.has(Part)) {
		invalidPluginDeclaration('[pluxel/core] PluginPart already has lowered required facts')
	}
	requiresByPart.set(
		Part,
		normalizePartAddresses(payload.requires, 'PluginPart required facts.requires'),
	)
}

/** @internal Build-generated optional Plugin edges declared by a Part. */
export function __setPluginPartOptional(
	Part: Function,
	input: PluginPartOptionalLoweringPayload,
): void {
	assertLoweringConstructor(Part, 'PluginPart optional target')
	rejectSealed(Part, 'PluginPart optional', sealedParts)
	const payload = parsePluginLoweringPayload(input, 'PluginPart optional facts', ['optional'])
	if (!Array.isArray(payload.optional)) {
		invalidPluginDeclaration('[pluxel/core] PluginPart optional facts.optional must be an array')
	}
	if (optionalByPart.has(Part)) {
		invalidPluginDeclaration('[pluxel/core] PluginPart already has lowered optional facts')
	}
	optionalByPart.set(
		Part,
		normalizePartAddresses(payload.optional, 'PluginPart optional facts.optional'),
	)
}

function normalizePartAddresses(input: readonly unknown[], label: string) {
	const seen = new Set<string>()
	const addresses = input.map((value, index) => {
		let address: PluginDefinitionAddress
		try {
			address = parsePluginDefinitionAddress(value)
		} catch (cause) {
			invalidPluginDeclaration(`[pluxel/core] ${label}[${index}] is invalid`, { cause })
		}
		const key = pluginDefinitionIndexKey(address)
		if (seen.has(key)) {
			invalidPluginDeclaration(`[pluxel/core] ${label} contains a duplicate at index ${index}`)
		}
		seen.add(key)
		return address
	})
	return Object.freeze(addresses)
}

/**
 * Builds an immutable, definition-local snapshot and seals every reachable Part fact.
 * The returned tree is the only Part metadata consumed by runtime construction.
 */
export function consumePluginPartDefinitionTree(owner: Function): PluginPartDefinitionTree {
	assertLoweringConstructor(owner, 'PluginPart tree owner')
	return buildTree(owner, new Set([owner]), [], new Map())
}

function buildTree(
	owner: Function,
	ancestry: ReadonlySet<Function>,
	path: readonly string[],
	memo: Map<Function, PluginPartDefinitionTree>,
): PluginPartDefinitionTree {
	const cached = memo.get(owner)
	if (cached) return cached
	sealedOwners.add(owner)
	const nodes = (occurrencesByOwner.get(owner) ?? EMPTY_OCCURRENCES).map((occurrence) => {
		const Part = occurrence.Part
		const nextPath = [...path, occurrence.fieldName]
		if (ancestry.has(Part)) {
			invalidPluginDeclaration(
				`[pluxel/core] PluginPart containment cycle at ${nextPath.join('.')}`,
			)
		}
		sealedParts.add(Part)
		const parts = buildTree(Part, new Set([...ancestry, Part]), nextPath, memo)
		const config = configByPart.get(Part)
		const requires = requiresByPart.get(Part) ?? EMPTY_REQUIRES
		const optional = optionalByPart.get(Part) ?? EMPTY_OPTIONAL
		return Object.freeze({
			fieldName: occurrence.fieldName,
			Part,
			...(config === undefined ? {} : { config }),
			requires,
			optional,
			parts,
		})
	})
	const tree = Object.freeze(nodes)
	memo.set(owner, tree)
	return tree
}
