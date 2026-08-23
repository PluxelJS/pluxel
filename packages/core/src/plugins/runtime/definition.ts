import type { StandardSchemaV1 } from '@standard-schema/spec'
import { isStandardSchemaV1 } from '../../services/config/standardSchema'
import { consumePluginMarker } from '../decorators/decorator/marker'
import type { PluginConstructor, PluginToken } from '../types'
import {
	parsePluginNodeAddress,
	parsePluginDefinitionAddress,
	pluginDefinitionIndexKey,
	type PluginDefinitionAddress,
	type PluginNodeAddress,
} from './identity'
import {
	assertLoweringConstructor,
	invalidPluginDeclaration,
	missingPluginDeclaration,
	parsePluginLoweringPayload,
	PluginLoweringError,
	type PluginLoweringHeader,
} from './lowering-abi'
import {
	consumePluginPartDefinitionTree,
	type PartConfigDeclaration,
	type PluginPartDefinitionTree,
} from './part-definition'

export type PluginDefinitionKind = 'plugin' | 'abstract'

export type PluginDefinitionLoweringPayload = PluginLoweringHeader &
	Readonly<{
		readonly kind: PluginDefinitionKind
		readonly definition: PluginDefinitionAddress
		readonly requires?: readonly PluginDefinitionAddress[]
		readonly optional?: readonly PluginDefinitionAddress[]
		readonly provides?: PluginDefinitionAddress
	}>

export type PluginConfigLoweringPayload = PluginLoweringHeader &
	Readonly<{
		readonly fieldName: string
		readonly schema: StandardSchemaV1
		readonly source?: string
	}>

export type PluginRefLoweringPayload = PluginLoweringHeader &
	Readonly<{ readonly definition: PluginDefinitionAddress }>

type PluginDefinitionFacts = Readonly<{
	readonly kind: PluginDefinitionKind
	readonly definition: PluginDefinitionAddress
	/** Ordered by constructor parameter index. */
	readonly requires: readonly PluginDefinitionAddress[]
	/** Static optional restart edges declared by direct init-time plugins.use() calls. */
	readonly optional: readonly PluginDefinitionAddress[]
	/** Explicit abstract provider relation from @Plugin(AbstractToken). */
	readonly provides?: PluginDefinitionAddress
}>

type PluginAddressProjection =
	| Readonly<{
			readonly kind: 'abstract'
			readonly definition: PluginDefinitionAddress
	  }>
	| Readonly<{
			readonly kind: 'plugin'
			readonly definition: PluginDefinitionAddress
			readonly defaultNode: PluginNodeAddress
	  }>

export type PluginConfigDefinition = Readonly<{
	readonly fieldName: string
	readonly schema: StandardSchemaV1
	readonly source?: string
	readonly owner?: PartConfigDeclaration
	readonly parts: readonly Readonly<{
		readonly path: readonly string[]
		readonly declaration?: PartConfigDeclaration
	}>[]
}>

export type ConcretePluginDefinitionDeclaration = Readonly<{
	readonly address: PluginDefinitionAddress
	readonly displayName: string
	readonly startTimeoutMs?: number
	readonly requires: readonly PluginDefinitionAddress[]
	readonly optional: readonly PluginDefinitionAddress[]
	readonly provides?: PluginDefinitionAddress
	readonly config?: PluginConfigDefinition
	readonly parts: PluginPartDefinitionTree
	readonly forkable: boolean
}>

export type ConcretePluginDefinitionCandidate = Readonly<{
	readonly implementation: PluginConstructor
	readonly declaration: ConcretePluginDefinitionDeclaration
}>

const factsByConstructor = new WeakMap<PluginToken, PluginDefinitionFacts>()
const addressByConstructor = new WeakMap<PluginToken, PluginAddressProjection>()
const configByConstructor = new WeakMap<PluginConstructor, PartConfigDeclaration>()
const consumedCandidates = new WeakSet<PluginConstructor>()
const candidateByImplementation = new WeakMap<
	PluginConstructor,
	ConcretePluginDefinitionCandidate
>()

/** @internal Route discovery remains true after ingestion drops mutable decorator staging. */
export function hasConsumedPluginDefinitionCandidate(ctor: Function): boolean {
	return candidateByImplementation.has(ctor as PluginConstructor)
}

function nonEmpty(value: unknown, label: string): string {
	if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
		invalidPluginDeclaration(
			`[pluxel/core] ${label} must be a non-empty string without surrounding whitespace`,
		)
	}
	return value
}

function parseAddress(value: unknown, label: string): PluginDefinitionAddress {
	try {
		return parsePluginDefinitionAddress(value)
	} catch (cause) {
		invalidPluginDeclaration(`[pluxel/core] ${label} is invalid`, { cause })
	}
}

function normalizeAddresses(input: unknown, label: string): readonly PluginDefinitionAddress[] {
	if (input === undefined) return Object.freeze([])
	if (!Array.isArray(input)) {
		invalidPluginDeclaration(`[pluxel/core] ${label} must be an array`)
	}
	const addresses = input.map((address, index) => parseAddress(address, `${label}[${index}]`))
	assertUniqueAddresses(addresses, label)
	return Object.freeze(addresses)
}

function assertUniqueAddresses(addresses: readonly PluginDefinitionAddress[], label: string): void {
	const seen = new Set<string>()
	for (let index = 0; index < addresses.length; index++) {
		const key = pluginDefinitionIndexKey(addresses[index]!)
		if (seen.has(key)) {
			invalidPluginDeclaration(
				`[pluxel/core] ${label} contains a duplicate definition at index ${index}`,
			)
		}
		seen.add(key)
	}
}

/** @internal Build-generated Plugin declaration facts. */
export function __setPluginDefinition(
	ctor: PluginToken,
	input: PluginDefinitionLoweringPayload,
): void {
	assertLoweringConstructor(ctor, 'Plugin definition target')
	if (consumedCandidates.has(ctor as PluginConstructor)) {
		invalidPluginDeclaration(
			'[pluxel/core] Plugin definition facts cannot change after candidate ingestion',
		)
	}
	const payload = parsePluginLoweringPayload(input, 'Plugin definition', [
		'kind',
		'definition',
		'requires',
		'optional',
		'provides',
	])
	if (payload.kind !== 'plugin' && payload.kind !== 'abstract') {
		invalidPluginDeclaration('[pluxel/core] Plugin definition kind must be plugin or abstract')
	}
	const requires = normalizeAddresses(payload.requires, 'Plugin required definition facts')
	const optional = normalizeAddresses(payload.optional, 'Plugin optional definition facts')
	const facts: PluginDefinitionFacts = Object.freeze({
		kind: payload.kind,
		definition: parseAddress(payload.definition, 'Plugin definition address'),
		requires,
		optional,
		...(payload.provides === undefined
			? {}
			: { provides: parseAddress(payload.provides, 'Plugin provider definition address') }),
	})
	if (
		facts.kind === 'abstract' &&
		(facts.requires.length > 0 || facts.optional.length > 0 || facts.provides)
	) {
		invalidPluginDeclaration('[pluxel/core] Abstract Plugin declaration cannot contain edges')
	}
	if (factsByConstructor.has(ctor)) {
		invalidPluginDeclaration('[pluxel/core] Plugin constructor already has declaration facts')
	}
	factsByConstructor.set(ctor, facts)
	addressByConstructor.set(
		ctor,
		facts.kind === 'plugin'
			? Object.freeze({
					kind: facts.kind,
					definition: facts.definition,
					defaultNode: parsePluginNodeAddress({
						definition: facts.definition,
						variant: 'default',
					}),
				})
			: Object.freeze({ kind: facts.kind, definition: facts.definition }),
	)
}

/** @internal Build-generated Plugin config declaration. */
export function __setPluginConfig(
	ctor: PluginConstructor,
	input: PluginConfigLoweringPayload,
): void {
	assertLoweringConstructor(ctor, 'Plugin config target')
	if (consumedCandidates.has(ctor)) {
		invalidPluginDeclaration(
			'[pluxel/core] Plugin config facts cannot change after candidate ingestion',
		)
	}
	const payload = parsePluginLoweringPayload(input, 'Plugin config', [
		'fieldName',
		'schema',
		'source',
	])
	if (configByConstructor.has(ctor)) {
		invalidPluginDeclaration('[pluxel/core] A Plugin may declare one object config schema')
	}
	const fieldName = nonEmpty(payload.fieldName, 'Plugin config field name')
	if (!isStandardSchemaV1(payload.schema)) {
		invalidPluginDeclaration('[pluxel/core] Plugin config must implement Standard Schema v1')
	}
	const source = payload.source
	if (source !== undefined && typeof source !== 'string') {
		invalidPluginDeclaration('[pluxel/core] Plugin config source must be a string')
	}
	configByConstructor.set(
		ctor,
		Object.freeze({
			fieldName,
			schema: payload.schema,
			...(source === undefined ? {} : { source: source as string }),
		}),
	)
}

/**
 * Atomically seals all evaluation-time staging for one concrete implementation.
 * Repeated readers receive the same frozen candidate object; HMR evaluates a new constructor.
 */
export function consumePluginDefinitionCandidate(
	implementation: PluginConstructor,
): ConcretePluginDefinitionCandidate {
	assertLoweringConstructor(implementation, 'Plugin candidate implementation')
	const cached = candidateByImplementation.get(implementation)
	if (cached) return cached
	if (consumedCandidates.has(implementation)) {
		invalidPluginDeclaration('[pluxel/core] Plugin candidate ingestion previously failed')
	}
	consumedCandidates.add(implementation)
	const facts = factsByConstructor.get(implementation)
	if (!facts) {
		missingPluginDeclaration(
			`[pluxel/core] Plugin declaration was not lowered for ${implementation.name || '<anonymous>'}. Load Plugin source through the Pluxel Vite/Rolldown semantic pass.`,
		)
	}
	if (facts.kind !== 'plugin') {
		invalidPluginDeclaration(
			`[pluxel/core] ${implementation.name || '<anonymous>'} is an abstract Plugin token, not a concrete implementation`,
		)
	}
	const marker = consumePluginMarker(implementation)
	if (!marker) {
		invalidPluginDeclaration(
			`[pluxel/core] Concrete Plugin ${implementation.name || '<anonymous>'} is missing @Plugin`,
		)
	}
	validateProviderMarker(marker.providerClass, facts.provides)
	const parts = consumePluginPartDefinitionTree(implementation)
	const optional = mergeOptionalDefinitions(facts.optional, collectPartOptional(parts))
	const config = createPluginConfigDefinition(configByConstructor.get(implementation), parts)
	const declaration: ConcretePluginDefinitionDeclaration = Object.freeze({
		address: facts.definition,
		displayName: marker.options.displayName ?? facts.definition.exportName,
		...(marker.options.startTimeoutMs === undefined
			? {}
			: { startTimeoutMs: marker.options.startTimeoutMs }),
		requires: facts.requires,
		optional,
		...(facts.provides === undefined ? {} : { provides: facts.provides }),
		...(config === undefined ? {} : { config }),
		parts,
		forkable: marker.options.forkable === true,
	})
	factsByConstructor.delete(implementation)
	configByConstructor.delete(implementation)
	const candidate = Object.freeze({ implementation, declaration })
	candidateByImplementation.set(implementation, candidate)
	return candidate
}

function validateProviderMarker(
	providerClass: PluginToken | undefined,
	provides: PluginDefinitionAddress | undefined,
): void {
	if (providerClass === undefined && provides === undefined) return
	if (providerClass === undefined || provides === undefined) {
		invalidPluginDeclaration(
			'[pluxel/core] @Plugin provider marker and lowered provides fact disagree',
		)
	}
	const provider = addressByConstructor.get(providerClass)
	if (!provider || provider.kind !== 'abstract') {
		invalidPluginDeclaration(
			'[pluxel/core] @Plugin provider target is missing an abstract lowered declaration',
		)
	}
	if (pluginDefinitionIndexKey(provider.definition) !== pluginDefinitionIndexKey(provides)) {
		invalidPluginDeclaration(
			'[pluxel/core] @Plugin provider marker and lowered provides address disagree',
		)
	}
}

/** Address-only author/host projection; it never materializes a node or reads candidate metadata. */
export function pluginDefinitionAddressOf(ctor: PluginToken): PluginDefinitionAddress {
	const facts = addressByConstructor.get(ctor)
	if (!facts) {
		missingPluginDeclaration(
			`[pluxel/core] Plugin declaration was not lowered for ${ctor.name || '<anonymous>'}`,
		)
	}
	return facts.definition
}

/** Default-node projection from a lowered concrete implementation. */
export function pluginNodeAddressOf(ctor: PluginConstructor): PluginNodeAddress {
	const facts = addressByConstructor.get(ctor)
	if (!facts) {
		missingPluginDeclaration(
			`[pluxel/core] Plugin declaration was not lowered for ${ctor.name || '<anonymous>'}`,
		)
	}
	if (facts.kind !== 'plugin') {
		invalidPluginDeclaration('[pluxel/core] Abstract Plugin tokens do not have node addresses')
	}
	return facts.defaultNode
}

function mergeOptionalDefinitions(
	direct: readonly PluginDefinitionAddress[],
	parts: readonly PluginDefinitionAddress[],
): readonly PluginDefinitionAddress[] {
	const out: PluginDefinitionAddress[] = []
	const seen = new Set<string>()
	for (const address of [...direct, ...parts]) {
		const key = pluginDefinitionIndexKey(address)
		if (seen.has(key)) continue
		seen.add(key)
		out.push(address)
	}
	return Object.freeze(out)
}

function collectPartOptional(tree: PluginPartDefinitionTree): PluginDefinitionAddress[] {
	const out: PluginDefinitionAddress[] = []
	const visit = (nodes: PluginPartDefinitionTree) => {
		for (const node of nodes) {
			out.push(...node.optional)
			visit(node.parts)
		}
	}
	visit(tree)
	return out
}

type ConfigNode = Readonly<{
	readonly path: readonly string[]
	readonly own?: PartConfigDeclaration
	readonly children: readonly Readonly<{ readonly key: string; readonly node: ConfigNode }>[]
}>

function createPluginConfigDefinition(
	rootConfig: PartConfigDeclaration | undefined,
	parts: PluginPartDefinitionTree,
): PluginConfigDefinition | undefined {
	const root = buildConfigNode([], rootConfig, parts)
	if (!root) return undefined
	const declarations: Array<{ path: readonly string[]; declaration?: PartConfigDeclaration }> = []
	const visit = (node: ConfigNode) => {
		if (node.path.length > 0) {
			declarations.push({
				path: node.path,
				...(node.own === undefined ? {} : { declaration: node.own }),
			})
		}
		for (const child of node.children) visit(child.node)
	}
	visit(root)
	const source = configNodeSource(root)
	return Object.freeze({
		fieldName: root.own?.fieldName ?? 'config',
		schema: root.children.length === 0 && root.own ? root.own.schema : createConfigTreeSchema(root),
		...(source === undefined ? {} : { source }),
		...(root.own === undefined ? {} : { owner: root.own }),
		parts: Object.freeze(declarations.map((item) => Object.freeze(item))),
	})
}

function buildConfigNode(
	path: readonly string[],
	own: PartConfigDeclaration | undefined,
	parts: PluginPartDefinitionTree,
): ConfigNode | undefined {
	const children = parts
		.map((part) => {
			const childPath = Object.freeze([...path, part.fieldName])
			const node = buildConfigNode(childPath, part.config, part.parts)
			return node ? Object.freeze({ key: part.fieldName, node }) : undefined
		})
		.filter((value): value is Readonly<{ key: string; node: ConfigNode }> => value !== undefined)
	if (!own && children.length === 0) return undefined
	return Object.freeze({
		path: Object.freeze([...path]),
		...(own === undefined ? {} : { own }),
		children: Object.freeze(children),
	})
}

function configNodeSource(node: ConfigNode): string | undefined {
	if (node.own && node.own.source === undefined) return undefined
	const children: string[] = []
	for (const child of node.children) {
		const source = configNodeSource(child.node)
		if (source === undefined) return undefined
		children.push(`${JSON.stringify(child.key)}:v.optional(${source},{})`)
	}
	const childObject = children.length > 0 ? `v.object({${children.join(',')}})` : undefined
	if (node.own?.source && childObject) return `v.intersect([${node.own.source},${childObject}])`
	return node.own?.source ?? childObject
}

function createConfigTreeSchema(root: ConfigNode): StandardSchemaV1 {
	return Object.freeze({
		'~standard': Object.freeze({
			version: 1 as const,
			vendor: 'pluxel',
			validate: async (input: unknown) => await validateConfigNode(root, input),
		}),
	})
}

async function validateConfigNode(
	node: ConfigNode,
	input: unknown,
): Promise<StandardSchemaV1.Result<Record<string, unknown>>> {
	const candidate = input === undefined ? {} : input
	if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
		return { issues: [{ message: 'Expected an object', path: node.path }] }
	}
	const record = candidate as Record<string, unknown>
	const childKeys = new Set(node.children.map((child) => child.key))
	const output: Record<string, unknown> = {}
	const issues: StandardSchemaV1.Issue[] = []
	if (node.own) {
		const ownInput: Record<string, unknown> = {}
		for (const [key, value] of Object.entries(record)) {
			if (!childKeys.has(key)) ownInput[key] = value
		}
		try {
			const ownResult = await node.own.schema['~standard'].validate(ownInput)
			if (!('value' in ownResult)) {
				for (const issue of ownResult.issues) {
					issues.push({ ...issue, path: [...node.path, ...(issue.path ?? [])] })
				}
			} else if (
				!ownResult.value ||
				typeof ownResult.value !== 'object' ||
				Array.isArray(ownResult.value)
			) {
				issues.push({ message: 'Config schema must produce an object', path: node.path })
			} else {
				Object.assign(output, ownResult.value)
			}
		} catch (error) {
			issues.push({
				message: error instanceof Error ? error.message : String(error),
				path: node.path,
			})
		}
	}
	for (const child of node.children) {
		if (Object.hasOwn(output, child.key)) {
			issues.push({
				message: `Config field conflicts with PluginPart ${child.key}`,
				path: [...node.path, child.key],
			})
			continue
		}
		const childResult = await validateConfigNode(child.node, record[child.key])
		if (!('value' in childResult)) issues.push(...childResult.issues)
		else output[child.key] = childResult.value
	}
	return issues.length > 0 ? { issues: Object.freeze(issues) } : { value: Object.freeze(output) }
}

const PLUGIN_REF = Symbol('PluginRef')

export type PluginRef<T> = Readonly<{
	readonly definition: PluginDefinitionAddress
	readonly [PLUGIN_REF]: (_value: T) => T
}>

export function definePluginRef<T>(): PluginRef<T> {
	throw new PluginLoweringError(
		'plugin_declaration_missing',
		'[pluxel/core] Plugin ref was not lowered. definePluginRef<T>() must be a non-exported module-level const processed by the Pluxel semantic pass.',
	)
}

/** @internal Build-generated PluginRef value. */
export function __definePluginRef<T>(input: PluginRefLoweringPayload): PluginRef<T> {
	const payload = parsePluginLoweringPayload(input, 'Plugin ref', ['definition'])
	return Object.freeze({
		definition: parseAddress(payload.definition, 'Plugin ref definition'),
		[PLUGIN_REF]: ((value: T) => value) as (_value: T) => T,
	})
}

export function isPluginRef(value: unknown): value is PluginRef<unknown> {
	return !!value && typeof value === 'object' && PLUGIN_REF in value
}
