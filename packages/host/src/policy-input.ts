import {
	parsePluginDefinitionAddress,
	parsePluginNodeAddress,
	pluginDefinitionIndexKey,
	pluginNodeIndexKey,
	type PluginDefinitionAddress,
	type PluginForkNodeAddress,
	type PluginNodeAddress,
} from '@pluxel/core'
import { assertStartTimeoutMs } from '@pluxel/core/internal'
import { readPluginNodeAddressEvidence } from '@pluxel/core/internal/plugin-address-evidence'
import { snapshotHostDocument, type HostDocumentOptions } from './document-storage'
import { parseHostInputMode, type HostInputMode } from './input-mode'
import {
	HOST_EXECUTION_POLICY_FIELDS,
	HOST_GLOBAL_POLICY_FIELDS,
	HOST_POLICY_FIELDS,
	type HostAutoStartChoice,
	type HostDependencyOverrideChoice,
	type HostForkChoice,
	type HostGlobalPolicyField,
	type HostNodePolicyMode,
	type HostPolicyField,
	type HostPolicyInput,
	type HostPolicyOptions,
	type HostPolicyPatch,
	type HostPolicyResetTarget,
	type HostProviderDefaultState,
} from './policy'

export class HostPolicyInputError extends TypeError {}

export type ResolvedHostPolicy = Readonly<{
	declared: HostPolicyInput
	mode: Readonly<Record<HostPolicyField, HostInputMode>>
	nodeModes: readonly HostNodePolicyMode[]
	document?: false | HostDocumentOptions
}>

export function snapshotHostPolicy(
	input: HostPolicyOptions = {},
	inputMode?: HostInputMode,
	choices: Pick<HostPolicyInput, 'autoStart' | 'forks' | 'dependencyOverrides'> = {},
	nodeModes: readonly HostNodePolicyMode[] = [],
): ResolvedHostPolicy {
	assertPolicyRecord(
		input,
		['mode', 'modes', 'document', 'providerDefaults', 'execution'],
		'policy',
	)
	const { mode, modes = {}, document, execution = {}, providerDefaults } = input
	assertPolicyRecord(modes, HOST_POLICY_FIELDS, 'policy.modes')
	assertPolicyRecord(execution, HOST_EXECUTION_POLICY_FIELDS, 'policy.execution')
	const fallback = mode === undefined ? inputMode : parseHostInputMode(mode, 'policy.mode')
	return Object.freeze({
		declared: canonicalHostPolicyInput({ ...choices, ...execution, providerDefaults }),
		mode: Object.freeze(
			Object.fromEntries(
				HOST_POLICY_FIELDS.map((field) => [
					field,
					parseHostInputMode(
						modes[field] === undefined ? fallback : modes[field],
						`policy.modes.${field}`,
					),
				]),
			),
		) as ResolvedHostPolicy['mode'],
		nodeModes: sortChoices(nodeModes, nodePolicyKey),
		document: snapshotHostDocument(document, 'policy.document'),
	})
}

export function canonicalHostPolicyInput(
	input: HostPolicyInput,
	optionalUndefined = true,
): HostPolicyInput {
	assertPolicyRecord(input, HOST_POLICY_FIELDS, 'policy input')
	const result: { -readonly [K in keyof HostPolicyInput]: HostPolicyInput[K] } = {}
	for (const field of HOST_POLICY_FIELDS) {
		const value = input[field]
		if (value === undefined && (optionalUndefined || !Object.hasOwn(input, field))) continue
		assertPortablePolicy(value)
		switch (field) {
			case 'autoStart': {
				const choices = parseChoices(value, field, parseAutoStart, nodePolicyKey)
				if (choices.length > 0) result[field] = choices
				break
			}
			case 'forks': {
				const choices = parseChoices(value, field, parseFork, nodePolicyKey)
				if (choices.length > 0) result[field] = choices
				break
			}
			case 'dependencyOverrides': {
				const choices = parseChoices(value, field, parseOverride, nodePolicyKey)
				if (choices.length > 0) result[field] = choices
				break
			}
			case 'providerDefaults':
				result[field] = parseChoices(value, field, parseProviderDefault, ({ token }) =>
					pluginDefinitionIndexKey(token),
				)
				break
			default:
				try {
					if (field.endsWith('TimeoutMs')) assertStartTimeoutMs(value, `[host] policy.${field}`)
					else if (!Number.isSafeInteger(value) || (value as number) < 1)
						throw new TypeError(`[host] policy.${field} must be a positive safe integer`)
				} catch (cause) {
					throw new HostPolicyInputError((cause as Error).message, { cause })
				}
				result[field] = value as number
		}
	}
	return Object.freeze(result)
}

export function nodePolicyKey(
	target:
		| Readonly<{ node: PluginNodeAddress }>
		| Pick<HostDependencyOverrideChoice, 'consumerAddress' | 'requirementAddress'>,
): string {
	return 'node' in target
		? pluginNodeIndexKey(target.node)
		: `${pluginNodeIndexKey(target.consumerAddress)}:${pluginDefinitionIndexKey(target.requirementAddress)}`
}

export function sortChoices<T>(input: readonly T[], key: (choice: T) => string): readonly T[] {
	return Object.freeze(
		input
			.map((choice) => ({ choice, key: key(choice) }))
			.sort((left, right) => left.key.localeCompare(right.key))
			.map(({ choice }) => choice),
	)
}

export function indexChoices<T extends Parameters<typeof nodePolicyKey>[0]>(
	input: readonly T[] | undefined,
): Map<string, T> {
	return new Map(input?.map((choice) => [nodePolicyKey(choice), choice]))
}

export function canonicalHostPolicyPatch(input: HostPolicyPatch): HostPolicyPatch {
	assertPolicyRecord(input, [...HOST_POLICY_FIELDS, 'reset'], 'policy patch')
	const { reset, ...values } = input
	const choices = canonicalHostPolicyInput(values)
	if (reset === undefined) return choices
	const targets = snapshotPolicyArray(reset, 'policy reset targets').map(parseResetTarget)
	const selected = new Set<string>()
	const choicesByKey = {
		autoStart: indexChoices(choices.autoStart),
		forks: indexChoices(choices.forks),
		dependencyOverrides: indexChoices(choices.dependencyOverrides),
	}
	for (const target of targets) {
		const key = typeof target === 'string' ? target : `${target.field}:${nodePolicyKey(target)}`
		const edited =
			typeof target === 'string'
				? Object.hasOwn(choices, target)
				: choicesByKey[target.field].has(nodePolicyKey(target))
		if (edited || selected.has(key))
			throw invalidState('policy edit and reset targets must be distinct')
		selected.add(key)
	}
	return Object.freeze({ ...choices, reset: Object.freeze(targets) })
}

export function applyHostPolicyPatch(
	current: HostPolicyInput,
	patch: HostPolicyPatch,
): HostPolicyInput {
	const { reset = [], ...values } = patch
	const autoStart = indexChoices(current.autoStart)
	const forks = indexChoices(current.forks)
	const dependencyOverrides = indexChoices(current.dependencyOverrides)
	const byField = { autoStart, forks, dependencyOverrides }
	const changed = { ...current, ...values }
	for (const target of reset) {
		if (typeof target === 'string') delete changed[target]
		else byField[target.field].delete(nodePolicyKey(target))
	}
	for (const choice of values.autoStart ?? []) autoStart.set(nodePolicyKey(choice), choice)
	for (const choice of values.forks ?? []) forks.set(nodePolicyKey(choice), choice)
	for (const choice of values.dependencyOverrides ?? [])
		dependencyOverrides.set(nodePolicyKey(choice), choice)
	return canonicalHostPolicyInput({
		...changed,
		autoStart: [...autoStart.values()],
		forks: [...forks.values()],
		dependencyOverrides: [...dependencyOverrides.values()],
	})
}

function parseResetTarget(value: unknown): HostPolicyResetTarget {
	if (typeof value === 'string') {
		if ((HOST_GLOBAL_POLICY_FIELDS as readonly string[]).includes(value))
			return value as HostGlobalPolicyField
		throw invalidState('policy reset requires a global field or a specific node target')
	}
	assertPolicyRecord(value, undefined, 'policy reset target')
	const field = value.field
	if (field === 'dependencyOverrides') {
		const { consumerAddress, requirementAddress } = closedRecord(value, 'policy reset target', [
			'field',
			'consumerAddress',
			'requirementAddress',
		])
		return Object.freeze({
			field,
			consumerAddress: parseNode(consumerAddress, 'policy reset consumerAddress'),
			requirementAddress: parseDefinition(requirementAddress, 'policy reset requirementAddress'),
		})
	}
	if (field !== 'autoStart' && field !== 'forks') throw invalidState('invalid policy reset field')
	const raw = closedRecord(value, 'policy reset target', ['field', 'node'])
	return field === 'autoStart'
		? Object.freeze({ field, node: parseNode(raw.node, 'policy reset node') })
		: Object.freeze({ field, node: parseForkNode(raw.node, 'policy reset node') })
}

function parseChoices<T>(
	input: unknown,
	label: string,
	parse: (value: unknown, path: string) => T,
	key: (choice: T) => string,
): readonly T[] {
	const entries = snapshotPolicyArray(input as readonly unknown[], `policy.${label}`)
	const seen = new Set<string>()
	return sortChoices(
		entries.map((entry, index) => {
			const path = `${label}[${index}]`
			const parsed = parse(entry, path)
			const id = key(parsed)
			if (seen.has(id)) throw invalidState(`${path} duplicates an earlier target`)
			seen.add(id)
			return Object.freeze(parsed)
		}),
		key,
	)
}

function parseAutoStart(value: unknown, path: string): HostAutoStartChoice {
	const { node, autoStart } = closedRecord(value, path, ['node', 'autoStart'])
	if (typeof autoStart !== 'boolean') throw invalidState(`${path}.autoStart must be a boolean`)
	return { node: parseNode(node, `${path}.node`), autoStart }
}

function parseFork(value: unknown, path: string): HostForkChoice {
	const { node, deploy } = closedRecord(value, path, ['node', 'deploy'])
	if (typeof deploy !== 'boolean') throw invalidState(`${path}.deploy must be a boolean`)
	return { node: parseForkNode(node, `${path}.node`), deploy }
}

function parseForkNode(value: unknown, path: string): PluginForkNodeAddress {
	const node = parseNode(value, path)
	if (node.variant !== 'fork') throw invalidState(`${path} must be a fork node address`)
	return node
}

function parseOverride(value: unknown, path: string): HostDependencyOverrideChoice {
	const { consumerAddress, requirementAddress, providerAddress } = closedRecord(value, path, [
		'consumerAddress',
		'requirementAddress',
		'providerAddress',
	])
	return {
		consumerAddress: parseNode(consumerAddress, `${path}.consumerAddress`),
		requirementAddress: parseDefinition(requirementAddress, `${path}.requirementAddress`),
		providerAddress:
			providerAddress === null ? null : parseNode(providerAddress, `${path}.providerAddress`),
	}
}

function parseProviderDefault(value: unknown, path: string): HostProviderDefaultState {
	const { token, provider } = closedRecord(value, path, ['token', 'provider'])
	return {
		token: parseDefinition(token, `${path}.token`),
		provider: parseNode(provider, `${path}.provider`),
	}
}

/** @internal Capture portable sequence structure before reading any element. */
export function snapshotPolicyArray<T>(input: readonly T[], label: string): readonly T[] {
	if (!Array.isArray(input)) throw new HostPolicyInputError(`[host] ${label} must be an array`)
	const descriptors = Object.getOwnPropertyDescriptors(input)
	for (const key of Reflect.ownKeys(descriptors)) {
		if (key === 'length') continue
		if (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= input.length)
			throw new HostPolicyInputError(`[host] ${label} cannot contain additional properties`)
		const descriptor = descriptors[key]!
		if (!descriptor.enumerable || !('value' in descriptor))
			throw new HostPolicyInputError(`[host] ${label} requires enumerable data properties`)
	}
	const output: T[] = []
	for (let index = 0; index < input.length; index++) {
		const descriptor = descriptors[String(index)]
		if (!descriptor) throw new HostPolicyInputError(`[host] ${label} must be a dense array`)
		output.push(descriptor.value as T)
	}
	return Object.freeze(output)
}
function assertPolicyRecord(
	value: unknown,
	keys: readonly string[] | undefined,
	label: string,
): asserts value is Record<string, unknown> {
	if (
		!value ||
		typeof value !== 'object' ||
		Array.isArray(value) ||
		![Object.prototype, null].includes(Object.getPrototypeOf(value))
	)
		throw new HostPolicyInputError(`[host] ${label} must be a plain object`)
	for (const key of Reflect.ownKeys(value)) {
		if (typeof key !== 'string' || (keys !== undefined && !keys.includes(key)))
			throw new HostPolicyInputError(`[host] ${label} includes unsupported ${String(key)}`)
		if (!Object.getOwnPropertyDescriptor(value, key)!.enumerable)
			throw new HostPolicyInputError(`[host] ${label} cannot contain hidden fields`)
		if (!('value' in Object.getOwnPropertyDescriptor(value, key)!))
			throw new HostPolicyInputError(`[host] ${label} cannot contain accessors`)
	}
}
function assertPortablePolicy(value: unknown, seen = new Set<object>()): void {
	if (
		value === null ||
		typeof value === 'string' ||
		typeof value === 'boolean' ||
		(typeof value === 'number' && Number.isFinite(value))
	)
		return
	if (value && typeof value === 'object') {
		let evidence: unknown
		try {
			evidence = readPluginNodeAddressEvidence(value as PluginNodeAddress)
		} catch (cause) {
			throw new HostPolicyInputError('[host] Plugin address evidence was copied or detached', {
				cause,
			})
		}
		if (evidence !== undefined) {
			assertPortablePolicy(parsePluginNodeAddress(value), seen)
			return
		}
	}
	if (
		!value ||
		typeof value !== 'object' ||
		seen.has(value) ||
		(!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
	)
		throw new HostPolicyInputError('[host] policy input must be a portable data tree')
	seen.add(value)
	for (const key of Reflect.ownKeys(value)) {
		if (Array.isArray(value) && key === 'length') continue
		if (typeof key !== 'string' || ['__proto__', 'prototype', 'constructor'].includes(key))
			throw new HostPolicyInputError('[host] unsafe policy input key')
		if (Array.isArray(value) && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length))
			throw new HostPolicyInputError('[host] policy arrays cannot contain additional properties')
		const descriptor = Object.getOwnPropertyDescriptor(value, key)!
		if (!descriptor.enumerable)
			throw new HostPolicyInputError('[host] policy input cannot contain hidden fields')
		if (!('value' in descriptor))
			throw new HostPolicyInputError('[host] policy input cannot contain accessors')
		assertPortablePolicy(descriptor.value, seen)
	}
	if (Array.isArray(value) && Object.keys(value).length !== value.length)
		throw new HostPolicyInputError('[host] policy arrays must be dense')
	seen.delete(value)
}
function parseDefinition(value: unknown, at: string): PluginDefinitionAddress {
	try {
		return parsePluginDefinitionAddress(value)
	} catch (error) {
		throw invalidState(`${at}: ${error instanceof Error ? error.message : String(error)}`)
	}
}

function parseNode(value: unknown, at: string): PluginNodeAddress {
	try {
		return parsePluginNodeAddress(value)
	} catch (error) {
		throw invalidState(`${at}: ${error instanceof Error ? error.message : String(error)}`)
	}
}

function closedRecord(
	value: unknown,
	at: string,
	keys: readonly string[],
): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw invalidState(`${at} must be an object`)
	}
	const record = value as Record<string, unknown>
	assertClosedRecord(record, keys, at)
	return record
}

function assertClosedRecord(
	record: object,
	keys: readonly string[],
	at: string,
	requireAll = true,
): void {
	const expected = new Set(keys)
	for (const key of Object.keys(record)) {
		if (!expected.has(key)) throw invalidState(`${at} has unknown field ${key}`)
	}
	if (!requireAll) return
	for (const key of keys) {
		if (!Object.hasOwn(record, key)) throw invalidState(`${at} is missing field ${key}`)
	}
}

function invalidState(message: string): Error {
	return new HostPolicyInputError(`[HostStateStore] ${message}`)
}
