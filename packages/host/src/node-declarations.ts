import {
	formatPluginDefinitionReference,
	parsePluginDefinitionAddress,
	parsePluginNodeAddress,
	pluginDefinitionIndexKey,
	pluginNodeIndexKey,
	type CoreFacilitiesConfig,
	type PluginConstructor,
	type PluginDefinitionAddress,
	type PluginForkNodeAddress,
	type PluginNodeAddress,
} from '@pluxel/core'
import {
	assertStartTimeoutMs,
	consumePluginDefinitionCandidate,
	type PreparedCoreFacilities,
} from '@pluxel/core/internal'
import type { VaultBindingRecord } from '@pluxel/core/vault'
import type { HostEnvironmentBinding, HostFileBinding, OwnedInputBindings } from './bindings'
import {
	assertDataObject,
	snapshotHostConfig,
	type HostConfigOptions,
	type ResolvedHostConfigOptions,
} from './config-records'
import { parseHostInputMode, type HostInputMode } from './input-mode'
import type { HostService } from './services'
import type { HostApplication } from './host'
import type {
	HostAutoStartChoice,
	HostDependencyOverrideChoice,
	HostForkChoice,
	HostNodePolicyMode,
	HostPolicyOptions,
} from './policy'
import { snapshotHostPolicy, snapshotPolicyArray, type ResolvedHostPolicy } from './policy-input'

export type HostPluginNodeOptions = Readonly<{
	autoStart?: boolean
	config?: Readonly<Record<string, unknown>>
	configMode?: HostInputMode
	policyMode?: HostInputMode
	startTimeoutMs?: number
	envBindings?: readonly HostEnvironmentBinding[]
	fileBindings?: readonly HostFileBinding[]
	dependencyOverrides?: readonly Pick<
		HostDependencyOverrideChoice,
		'requirementAddress' | 'providerAddress'
	>[]
}>

type UnboundNodeOptions = Omit<HostPluginNodeOptions, 'envBindings' | 'fileBindings'> &
	Readonly<{ envBindings?: never; fileBindings?: never }>
type HostPluginForkOptions<Node> = Omit<Node, 'autoStart' | 'dependencyOverrides'> &
	(
		| (Pick<HostPluginNodeOptions, 'autoStart' | 'dependencyOverrides'> &
				Readonly<{ deploy?: true }>)
		| Readonly<{ deploy: boolean; autoStart?: false; dependencyOverrides?: never }>
	)
type WithForks<Node> = Node &
	Readonly<{ forks?: Readonly<Record<string, HostPluginForkOptions<Node>>> }>
export type HostPluginDeclaration<Node = HostPluginNodeOptions> = WithForks<Node> &
	Readonly<{ plugin: PluginConstructor }>
export type HostPluginNodesDeclaration<Node = HostPluginNodeOptions> = WithForks<Node> &
	Readonly<{ definition: PluginDefinitionAddress }>

export type HostDeclarations<Node = HostPluginNodeOptions> = Readonly<{
	name?: string
	plugins?: readonly HostPluginDeclaration<Node>[]
	pluginNodes?: readonly HostPluginNodesDeclaration<Node>[]
	services?: readonly HostService[]
	coreConfig?: CoreFacilitiesConfig
	policy?: HostPolicyOptions
	config?: HostConfigOptions
}>

export type HostOptions = HostDeclarations<UnboundNodeOptions> &
	Readonly<{
		/** Complete already-resolved read-only Vault records. Application factories declare node bindings. */
		vaultBindings?: readonly VaultBindingRecord[]
	}>

export type SnapshotCoreFacilities = (input?: CoreFacilitiesConfig) => PreparedCoreFacilities

export type ResolvedHostOptions = Readonly<{
	name?: string
	plugins: readonly PluginConstructor[]
	declaredNodes: readonly PluginNodeAddress[]
	services?: readonly HostService[]
	coreConfig: PreparedCoreFacilities
	policy: ResolvedHostPolicy
	config: ResolvedHostConfigOptions
	vaultBindings?: readonly VaultBindingRecord[]
	nodeStartTimeoutMs: ReadonlyMap<string, number>
}>

export const HOST_DECLARATION_FIELDS = [
	'name',
	'plugins',
	'pluginNodes',
	'services',
	'coreConfig',
	'policy',
	'config',
] as const
const lifecycleFields = ['prepare', 'acceptStartup', 'launch'] as const
const applicationFields = [...HOST_DECLARATION_FIELDS, ...lifecycleFields]
const managedFields = [...applicationFields, 'sources']

export function assertApplicationShape(
	input: unknown,
	driver: 'embedded' | 'managed',
): asserts input is HostApplication {
	assertDataObject(input, 'Application', driver === 'managed' ? managedFields : applicationFields)
	for (const key of lifecycleFields)
		if (input[key] !== undefined && typeof input[key] !== 'function')
			throw new TypeError(`[host] Application ${key} must be a function`)
}

const nodeFields = [
	'autoStart',
	'config',
	'configMode',
	'policyMode',
	'startTimeoutMs',
	'envBindings',
	'fileBindings',
	'dependencyOverrides',
] as const

/** Both application drivers and portable Hosts interpret the same code declarations. */
export function snapshotHostDeclarations(input: HostDeclarations): {
	options: Omit<ResolvedHostOptions, 'coreConfig'>
	bindings: OwnedInputBindings
} {
	if (input.name !== undefined && (typeof input.name !== 'string' || !input.name.trim()))
		throw new TypeError('[host] name must be a non-empty string')
	const plugins: PluginConstructor[] = []
	const declaredNodes: PluginNodeAddress[] = []
	const definitions = new Map<string, string>()
	const autoStart: HostAutoStartChoice[] = []
	const forks: HostForkChoice[] = []
	const dependencyOverrides: HostDependencyOverrideChoice[] = []
	const nodeModes: HostNodePolicyMode[] = []
	const records: ResolvedHostConfigOptions['records'][number][] = []
	const nodeStartTimeoutMs = new Map<string, number>()
	const envBindings: OwnedInputBindings['envBindings'][number][] = []
	const fileBindings: OwnedInputBindings['fileBindings'][number][] = []

	const addNode = (
		owner: PluginNodeAddress,
		declaration: HostPluginNodeOptions,
		label: string,
		config: HostPluginNodeOptions['config'],
	) => {
		declaredNodes.push(owner)
		if (declaration.autoStart !== undefined) {
			if (typeof declaration.autoStart !== 'boolean')
				throw new TypeError(`[host] ${label}.autoStart must be a boolean`)
			autoStart.push({ node: owner, autoStart: declaration.autoStart })
		}
		if (config !== undefined || declaration.configMode !== undefined) {
			records.push({ owner, mode: declaration.configMode, config })
		}
		if (declaration.policyMode !== undefined) {
			nodeModes.push(
				Object.freeze({
					node: owner,
					mode: parseHostInputMode(declaration.policyMode, `${label}.policyMode`),
				}),
			)
		}
		if (declaration.startTimeoutMs !== undefined) {
			assertStartTimeoutMs(declaration.startTimeoutMs, `[host] ${label}.startTimeoutMs`)
			nodeStartTimeoutMs.set(pluginNodeIndexKey(owner), declaration.startTimeoutMs)
		}
		for (const entry of optionalArray(
			declaration.dependencyOverrides,
			`${label}.dependencyOverrides`,
		)) {
			assertDataObject(entry, `${label}.dependencyOverrides entry`, [
				'requirementAddress',
				'providerAddress',
			])
			dependencyOverrides.push({ consumerAddress: owner, ...entry })
		}
		for (const binding of optionalArray(declaration.envBindings, `${label}.envBindings`)) {
			assertDataObject(binding, `${label}.envBindings entry`, ['config', 'vault'])
			envBindings.push({ ...binding, plugin: owner })
		}
		for (const binding of optionalArray(declaration.fileBindings, `${label}.fileBindings`)) {
			assertDataObject(binding, `${label}.fileBindings entry`, ['config', 'vault'])
			fileBindings.push({ ...binding, plugin: owner })
		}
	}

	const addDeclaration = (
		definition: PluginDefinitionAddress,
		entry: WithForks<HostPluginNodeOptions>,
		label: string,
	) => {
		const key = pluginDefinitionIndexKey(definition)
		const previous = definitions.get(key)
		if (previous !== undefined)
			throw new TypeError(
				`[host] ${label} duplicates ${previous} for ${formatPluginDefinitionReference(definition)}`,
			)
		definitions.set(key, label)
		addNode(parsePluginNodeAddress({ definition, variant: 'default' }), entry, label, entry.config)
		if (entry.forks === undefined) return
		assertDataObject(entry.forks, `${label}.forks`)
		for (const [forkId, fork] of Object.entries(entry.forks)) {
			const forkLabel = `${label}.forks[${JSON.stringify(forkId)}]`
			assertDataObject(fork, forkLabel, [...nodeFields, 'deploy'])
			if (fork.deploy !== undefined && typeof fork.deploy !== 'boolean')
				throw new TypeError(`[host] ${forkLabel}.deploy must be a boolean`)
			const node: HostPluginNodeOptions = fork
			if (
				fork.deploy === false &&
				(node.autoStart === true || node.dependencyOverrides !== undefined)
			)
				throw new TypeError(
					`[host] ${forkLabel} with deploy: false cannot enable autoStart or declare dependencyOverrides`,
				)
			const owner = parsePluginNodeAddress({
				definition,
				variant: 'fork',
				forkId,
			}) as PluginForkNodeAddress
			if (fork.deploy !== false) forks.push({ node: owner, deploy: true })
			addNode(owner, fork, forkLabel, fork.config === undefined ? entry.config : fork.config)
		}
	}

	for (const [index, entry] of optionalArray(input.plugins, 'plugins').entries()) {
		const label = `plugins[${index}]`
		assertDataObject(entry, label, ['plugin', 'forks', ...nodeFields])
		const plugin = entry.plugin
		if (typeof plugin !== 'function')
			throw new TypeError(`[host] ${label}.plugin must be a Plugin constructor`)
		const { declaration } = consumePluginDefinitionCandidate(plugin)
		addDeclaration(declaration.address, entry, label)
		if (!declaration.forkable && entry.forks !== undefined && Object.keys(entry.forks).length > 0)
			throw new TypeError(`[host] ${label}.forks requires a forkable Plugin`)
		plugins.push(plugin)
	}
	for (const [index, entry] of optionalArray(input.pluginNodes, 'pluginNodes').entries()) {
		const label = `pluginNodes[${index}]`
		assertDataObject(entry, label, ['definition', 'forks', ...nodeFields])
		let definition: PluginDefinitionAddress
		try {
			definition = parsePluginDefinitionAddress(entry.definition)
		} catch (cause) {
			throw new TypeError(`[host] ${label}.definition must be a Plugin definition address`, {
				cause,
			})
		}
		addDeclaration(definition, entry, label)
	}
	return {
		options: Object.freeze({
			name: input.name,
			plugins: Object.freeze(plugins),
			declaredNodes: Object.freeze(declaredNodes),
			services:
				input.services === undefined ? undefined : snapshotPolicyArray(input.services, 'services'),
			config: snapshotHostConfig(input.config, records),
			policy: snapshotHostPolicy(
				input.policy,
				{ autoStart, forks, dependencyOverrides },
				nodeModes,
			),
			nodeStartTimeoutMs,
		}),
		bindings: { envBindings, fileBindings },
	}
}

function optionalArray<T>(value: readonly T[] | undefined, label: string): readonly T[] {
	return value === undefined ? [] : snapshotPolicyArray(value, label)
}
