import {
	parsePluginNodeAddress,
	pluginNodeAddressEqual,
	type PluginConstructor,
	type PluginNodeAddress,
} from '@pluxel/core'
import type { PluginConfigRecordSnapshot } from '@pluxel/core/services'
import type { StandardSchemaV1 } from '@standard-schema/spec'
import { parseHostInputMode, type HostInputMode } from './input-mode'

export type ConfigInputPatch<T> = T extends readonly unknown[]
	? T
	: T extends object
		? { readonly [K in keyof T]?: ConfigInputPatch<T[K]> }
		: T
export type HostConfigRecordInput = Readonly<{
	owner: PluginConstructor | PluginNodeAddress
	mode?: HostInputMode
	config?: Readonly<Record<string, unknown>>
}>
export type HostConfigOptions = Readonly<{
	mode?: HostInputMode
	records?: readonly HostConfigRecordInput[]
}>
export type ResolvedHostConfigRecord = Readonly<{
	owner: PluginNodeAddress
	mode?: HostInputMode
	config?: Readonly<Record<string, unknown>>
}>
export type ResolvedHostConfigOptions = Readonly<{
	mode: HostInputMode
	records: readonly ResolvedHostConfigRecord[]
}>
export type ConfigDeclarationSource = Readonly<{
	owner: PluginNodeAddress
	path: readonly string[]
	kind: 'file' | 'env'
	name: string
}>
export type ConfigBindingProof = Readonly<{
	owner: PluginNodeAddress
	schema: StandardSchemaV1
	paths: readonly (readonly string[])[]
}>
type ConfigProvenance = Readonly<{
	sources: readonly ConfigDeclarationSource[]
	bindings: readonly ConfigBindingProof[]
}>
const provenance = new WeakMap<object, ConfigProvenance>()
export function configProvenance(options: object): ConfigProvenance {
	return provenance.get(options) ?? { sources: [], bindings: [] }
}
export function attachConfigProvenance(options: object, facts: ConfigProvenance): void {
	provenance.set(options, facts)
}

export function snapshotHostConfig(input: HostConfigOptions = {}): ResolvedHostConfigOptions {
	assertDataObject(input, 'config', ['mode', 'records'])
	const mode = parseHostInputMode(input.mode, 'config.mode')
	const records: ResolvedHostConfigRecord[] = []
	for (const record of dataArray(input.records ?? [], 'config.records')) {
		assertDataObject(record, 'config record', ['owner', 'mode', 'config'])
		if (record.mode === undefined && record.config === undefined)
			throw new TypeError('[host] config record requires mode or config')
		const owner = parsePluginNodeAddress(
			typeof record.owner === 'function'
				? (record.owner as PluginConstructor).nodeAddress()
				: record.owner,
		)
		if (records.some((entry) => pluginNodeAddressEqual(entry.owner, owner)))
			throw new TypeError('[host] config.records duplicates a Plugin node owner')
		records.push(
			Object.freeze({
				owner,
				...(record.mode === undefined
					? {}
					: { mode: parseHostInputMode(record.mode, 'config record.mode') }),
				...(record.config === undefined ? {} : { config: snapshotConfigInput(record.config) }),
			}),
		)
	}
	const result = Object.freeze({ mode, records: Object.freeze(records) })
	const facts = provenance.get(input)
	if (facts) provenance.set(result, facts)
	return result
}

export function assertDataObject(
	value: unknown,
	label: string,
	fields?: readonly string[],
): asserts value is Record<string, unknown> {
	if (!isRecord(value)) throw new TypeError(`[host] ${label} must be a plain object`)
	for (const key of Reflect.ownKeys(value)) {
		if (typeof key !== 'string' || (fields && !fields.includes(key)))
			throw new TypeError(`[host] ${label} includes an unsupported field`)
		const descriptor = Object.getOwnPropertyDescriptor(value, key)!
		if (!descriptor.enumerable || !('value' in descriptor))
			throw new TypeError(`[host] ${label} requires enumerable data properties`)
	}
}

export function snapshotConfigInput(value: unknown): Readonly<Record<string, unknown>> {
	assertDataObject(value, 'config input')
	return portable(value, new Set(), []) as Readonly<Record<string, unknown>>
}
function portable(value: unknown, seen: Set<object>, path: readonly string[]): unknown {
	if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
	if (typeof value === 'number' && Number.isFinite(value)) return value
	if (!value || typeof value !== 'object' || (!Array.isArray(value) && !isRecord(value)))
		throw new TypeError(
			`[host] config input at ${path.join('.') || '<root>'} must be portable data`,
		)
	if (seen.has(value)) throw new TypeError('[host] config input must not contain cycles')
	seen.add(value)
	try {
		if (Array.isArray(value)) {
			if (Reflect.ownKeys(value).length !== value.length + 1)
				throw new TypeError('[host] config arrays must be dense and contain only indexed values')
			return Object.freeze(
				Array.from({ length: value.length }, (_, index) => {
					const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
					if (!descriptor?.enumerable || !('value' in descriptor))
						throw new TypeError('[host] config arrays require dense data elements')
					return portable(descriptor.value, seen, [...path, String(index)])
				}),
			)
		}
		assertDataObject(value, 'config input')
		const result: Record<string, unknown> = Object.create(null)
		for (const key of Object.keys(value)) {
			if (!key || key.includes('\0') || ['__proto__', 'constructor', 'prototype'].includes(key))
				throw new TypeError('[host] config input contains an unsafe field')
			result[key] = portable(value[key], seen, [...path, key])
		}
		return Object.freeze(result)
	} finally {
		seen.delete(value)
	}
}

export function mergeConfigRecords(
	base: readonly PluginConfigRecordSnapshot[] | undefined,
	override: readonly PluginConfigRecordSnapshot[] | undefined,
): PluginConfigRecordSnapshot[] {
	const merged: PluginConfigRecordSnapshot[] = []
	for (const entry of [...(base ?? []), ...(override ?? [])]) {
		const owner = parsePluginNodeAddress(entry.owner)
		const index = merged.findIndex((record) => pluginNodeAddressEqual(record.owner, owner))
		const next = { owner, config: mergeRecord(merged[index]?.config, entry.config) }
		if (index < 0) merged.push(next)
		else merged[index] = next
	}
	return merged
}
export function coercePluginConfigRecords(input: unknown): PluginConfigRecordSnapshot[] {
	const records: PluginConfigRecordSnapshot[] = []
	for (const entry of dataArray(input, 'persisted plugins')) {
		assertDataObject(entry, 'persisted config record', ['owner', 'config'])
		const owner = parsePluginNodeAddress(entry.owner)
		if (records.some((record) => pluginNodeAddressEqual(record.owner, owner)))
			throw new TypeError('[ConfigService] Persisted plugins duplicate a Plugin node owner')
		records.push(Object.freeze({ owner, config: snapshotConfigInput(entry.config) }))
	}
	return records
}
function dataArray(input: unknown, label: string): unknown[] {
	if (!Array.isArray(input) || Reflect.ownKeys(input).length !== input.length + 1)
		throw new TypeError(`[host] ${label} must be a dense array of data elements`)
	return Array.from({ length: input.length }, (_, index) => {
		const descriptor = Object.getOwnPropertyDescriptor(input, String(index))
		if (!descriptor?.enumerable || !('value' in descriptor))
			throw new TypeError(`[host] ${label} must contain only indexed data elements`)
		return descriptor.value
	})
}
export function mergeRecord(
	base: Readonly<Record<string, unknown>> | undefined,
	override: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> {
	const merged: Record<string, unknown> = Object.create(null)
	for (const [key, value] of Object.entries(base ?? {})) merged[key] = clone(value)
	for (const [key, value] of Object.entries(override ?? {}))
		merged[key] =
			isRecord(merged[key]) && isRecord(value) ? mergeRecord(merged[key], value) : clone(value)
	return merged
}
function clone(value: unknown): unknown {
	return Array.isArray(value)
		? value.map(clone)
		: isRecord(value)
			? mergeRecord(undefined, value)
			: value
}
function isRecord(value: unknown): value is Record<string, unknown> {
	return (
		!!value &&
		typeof value === 'object' &&
		!Array.isArray(value) &&
		[Object.prototype, null].includes(Object.getPrototypeOf(value))
	)
}
