import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { PluginDefinitionAddress } from './identity'

export type PluginPartClass<T extends object = object> = Function & {
	readonly prototype: T
}

export type PartConfigDeclaration = Readonly<{
	readonly fieldName: string
	readonly schema: StandardSchemaV1
	readonly source?: string
}>

export type PluginPartOccurrence = Readonly<{
	readonly fieldName: string
	readonly Part: PluginPartClass
}>

const occurrencesByOwner = new WeakMap<Function, readonly PluginPartOccurrence[]>()
const configByPart = new WeakMap<Function, PartConfigDeclaration>()
const optionalByPart = new WeakMap<Function, readonly PluginDefinitionAddress[]>()
const EMPTY_OCCURRENCES: readonly PluginPartOccurrence[] = Object.freeze([])
const EMPTY_OPTIONAL: readonly PluginDefinitionAddress[] = Object.freeze([])

let factsRevision = 0

function nonEmpty(value: unknown, label: string): string {
	if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
		throw new TypeError(`[pluxel/core] ${label} must be a non-empty trimmed string`)
	}
	return value
}

function assertConstructor(value: unknown, label: string): asserts value is Function {
	if (typeof value !== 'function') throw new TypeError(`[pluxel/core] ${label} must be a class`)
}

/** @internal Build-generated Part containment facts. */
export function __setPluginParts(
	owner: Function,
	input: readonly { readonly fieldName: string; readonly Part: PluginPartClass }[],
): void {
	assertConstructor(owner, 'Part owner')
	if (!Array.isArray(input)) throw new TypeError('[pluxel/core] Plugin Part facts must be an array')
	if (occurrencesByOwner.has(owner)) {
		throw new Error('[pluxel/core] Part owner already has lowered occurrence facts')
	}
	const fields = new Set<string>()
	const occurrences = input.map((item, index) => {
		if (!item || typeof item !== 'object') {
			throw new TypeError(`[pluxel/core] Plugin Part facts[${index}] must be an object`)
		}
		const fieldName = nonEmpty(item.fieldName, `Plugin Part facts[${index}].fieldName`)
		if (fields.has(fieldName)) {
			throw new Error(`[pluxel/core] Part owner declares duplicate field ${fieldName}`)
		}
		fields.add(fieldName)
		assertConstructor(item.Part, `Plugin Part facts[${index}].Part`)
		return Object.freeze({ fieldName, Part: item.Part })
	})
	occurrencesByOwner.set(owner, Object.freeze(occurrences))
	factsRevision++
}

/** @internal Build-generated Part config declaration. */
export function __setPluginPartConfig(Part: Function, input: PartConfigDeclaration): void {
	assertConstructor(Part, 'PluginPart config target')
	if (configByPart.has(Part)) {
		throw new Error('[pluxel/core] A PluginPart may declare exactly one object config schema')
	}
	const fieldName = nonEmpty(input.fieldName, 'PluginPart config field name')
	const standard = input.schema?.['~standard']
	if (!standard || standard.version !== 1 || typeof standard.validate !== 'function') {
		throw new TypeError('[pluxel/core] PluginPart config must implement Standard Schema v1')
	}
	configByPart.set(
		Part,
		Object.freeze({
			fieldName,
			schema: input.schema,
			...(input.source === undefined ? {} : { source: String(input.source) }),
		}),
	)
	factsRevision++
}

/** @internal Build-generated optional Plugin edges declared by a Part. */
export function __setPluginPartOptional(
	Part: Function,
	optional: readonly PluginDefinitionAddress[],
): void {
	assertConstructor(Part, 'PluginPart optional target')
	if (!Array.isArray(optional)) {
		throw new TypeError('[pluxel/core] PluginPart optional facts must be an array')
	}
	if (optionalByPart.has(Part)) {
		throw new Error('[pluxel/core] PluginPart already has lowered optional facts')
	}
	optionalByPart.set(Part, Object.freeze([...optional]))
	factsRevision++
}

export function getPluginPartOccurrences(owner: Function): readonly PluginPartOccurrence[] {
	return occurrencesByOwner.get(owner) ?? EMPTY_OCCURRENCES
}

export function getPluginPartConfig(Part: Function): PartConfigDeclaration | undefined {
	return configByPart.get(Part)
}

export function getPluginPartOptional(Part: Function): readonly PluginDefinitionAddress[] {
	return optionalByPart.get(Part) ?? EMPTY_OPTIONAL
}

export function getPluginPartFactsRevision(): number {
	return factsRevision
}

export function clonePluginPartOwnerFacts(from: Function, to: Function): void {
	const occurrences = occurrencesByOwner.get(from)
	if (occurrences) occurrencesByOwner.set(to, occurrences)
	factsRevision++
}
