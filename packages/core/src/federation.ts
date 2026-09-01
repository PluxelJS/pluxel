import {
	encodePluginDefinitionAddressBytes,
	parsePluginDefinitionAddress,
	pluginDefinitionAddressEqual,
	type PluginDefinitionAddress,
} from './plugins/runtime/identity'

export const WORKBENCH_PROFILE_VERSION = 1 as const
export const WORKBENCH_FEDERATION_BUILD_CONTRACT_VERSION = 2 as const
export const WORKBENCH_FEDERATION_BUILD_ROOT = 'dist' as const
export const WORKBENCH_FEDERATION_OUT_DIR = 'workbench' as const
export const WORKBENCH_FEDERATION_MANIFEST_FILE = 'mf-manifest.json' as const
export const WORKBENCH_FEDERATION_REMOTE_ENTRY_FILE = 'remoteEntry.js' as const
export const WORKBENCH_FEDERATION_PRODUCER_INVENTORY_FILE =
	'pluxel-workbench-producers.json' as const
export const WORKBENCH_FEDERATION_PRODUCER_INVENTORY_VERSION = 1 as const
export const WORKBENCH_FEDERATION_SHARE_STRATEGY = 'loaded-first' as const
export const WORKBENCH_FEDERATION_BRIDGE = 'react' as const
export const WORKBENCH_FEDERATION_VITE_VERSION = '1.21.1' as const
export const WORKBENCH_FEDERATION_RUNTIME_VERSION = '2.9.0' as const
export const WORKBENCH_FEDERATION_REACT_BRIDGE_VERSION = '2.9.0' as const
export const WORKBENCH_FEDERATION_MANTINE_VERSION = '9.5.2' as const

/**
 * Profile 1 platform shares. Producers cannot add, remove, override, or provide
 * fallbacks for these entries. React subpaths use the exact `react`/`react-dom`
 * versions resolved for this compatibility set. Mantine is a fixed Shell-provided
 * Workbench UI dependency so every remote root reuses one module instance.
 */
export const WORKBENCH_FEDERATION_SHARED_MODULES = [
	'react',
	'react/jsx-runtime',
	'react/jsx-dev-runtime',
	'react-dom',
	'react-dom/client',
	'@mantine/core',
	'@mantine/hooks',
	'@module-federation/bridge-react',
	'@pluxel/runtime/workbench',
	'@pluxel/runtime/workbench/client',
	'@pluxel/runtime/workbench/react',
	'@pluxel/runtime/internal/workbench-react',
] as const

export type WorkbenchFederationSharedModule = (typeof WORKBENCH_FEDERATION_SHARED_MODULES)[number]

export type WorkbenchFederationCompatibilitySet = Readonly<{
	profile: typeof WORKBENCH_PROFILE_VERSION
	buildContract: typeof WORKBENCH_FEDERATION_BUILD_CONTRACT_VERSION
	moduleFederation: Readonly<{
		vite: typeof WORKBENCH_FEDERATION_VITE_VERSION
		runtime: typeof WORKBENCH_FEDERATION_RUNTIME_VERSION
		bridgeReact: typeof WORKBENCH_FEDERATION_REACT_BRIDGE_VERSION
	}>
	shared: Readonly<Record<WorkbenchFederationSharedModule, string>>
}>

export type WorkbenchFederationPlatformVersions = Readonly<{
	react: string
	reactDom: string
	runtime: string
}>

export type WorkbenchFederationManifestExpectation = Readonly<{
	plan: WorkbenchFederationProducerPlan
	compatibility: WorkbenchFederationCompatibilitySet
}>

export type WorkbenchFederationManifestContract = Readonly<{
	files: readonly string[]
}>

export type WorkbenchViewDeclarationIdentity = Readonly<{
	kind: 'view'
	owner: PluginDefinitionAddress
	key: string
}>

export type WorkbenchPageIdentity = Readonly<{
	kind: 'page'
	owner: PluginDefinitionAddress
	key: string
}>

export type WorkbenchAttachmentDeclarationIdentity = Readonly<{
	kind: 'attachment'
	owner: PluginDefinitionAddress
	key: string
}>

export type WorkbenchDeclarationIdentity =
	| WorkbenchViewDeclarationIdentity
	| WorkbenchAttachmentDeclarationIdentity

export type WorkbenchAttachmentPlacementIdentity = Readonly<{
	kind: 'attachment-placement'
	consumer: PluginDefinitionAddress
	key: string
	provider: WorkbenchAttachmentDeclarationIdentity
}>

export type WorkbenchOpenableIdentity =
	| WorkbenchViewDeclarationIdentity
	| WorkbenchPageIdentity
	| WorkbenchAttachmentPlacementIdentity

export type WorkbenchFederationDescriptorIdentity = WorkbenchDeclarationIdentity

export type WorkbenchFederationProducerEntry = Readonly<{
	descriptor: WorkbenchFederationDescriptorIdentity
	expose: `./views/${string}`
	bridgeEntryPath: string
}>

/**
 * The only input accepted by the Workbench producer compiler.
 *
 * Runtime descriptor readers provide kind/key/renderer provenance without an owner.
 * The Plugin semantic pass supplies the owning canonical definition and generated
 * React Bridge entry, then freezes this plan. Source paths are build provenance and
 * never participate in producer or descriptor identity.
 */
export type WorkbenchFederationProducerPlan = Readonly<{
	profile: typeof WORKBENCH_PROFILE_VERSION
	definition: PluginDefinitionAddress
	buildRevision: string
	producer: string
	entries: readonly WorkbenchFederationProducerEntry[]
}>

export type CreateWorkbenchFederationProducerPlanInput = Readonly<{
	definition: PluginDefinitionAddress
	buildRevision: string
	entries: readonly Readonly<{
		descriptor: WorkbenchFederationDescriptorIdentity
		bridgeEntryPath: string
	}>[]
}>

export type WorkbenchFederationDeploymentProducer = Readonly<{
	plan: WorkbenchFederationProducerPlan
	/** Path relative to the deployment/build root. */
	artifactRoot: string
}>

export type WorkbenchFederationDeploymentInventory = Readonly<{
	version: typeof WORKBENCH_FEDERATION_PRODUCER_INVENTORY_VERSION
	profile: typeof WORKBENCH_PROFILE_VERSION
	buildContract: typeof WORKBENCH_FEDERATION_BUILD_CONTRACT_VERSION
	producers: readonly WorkbenchFederationDeploymentProducer[]
}>

/** Builds the one exact Profile 1 compatibility set shared by producer and host validation. */
export function createWorkbenchFederationCompatibilitySet(
	input: WorkbenchFederationPlatformVersions,
): WorkbenchFederationCompatibilitySet {
	const versions = readExactRecord(input, 'platform versions', ['react', 'reactDom', 'runtime'])
	const react = readNonEmptyText(versions.react, 'React version')
	const reactDom = readNonEmptyText(versions.reactDom, 'React DOM version')
	const runtime = readNonEmptyText(versions.runtime, 'Runtime version')
	const shared = Object.freeze({
		react,
		'react/jsx-runtime': react,
		'react/jsx-dev-runtime': react,
		'react-dom': reactDom,
		'react-dom/client': reactDom,
		'@mantine/core': WORKBENCH_FEDERATION_MANTINE_VERSION,
		'@mantine/hooks': WORKBENCH_FEDERATION_MANTINE_VERSION,
		'@module-federation/bridge-react': WORKBENCH_FEDERATION_REACT_BRIDGE_VERSION,
		'@pluxel/runtime/workbench': runtime,
		'@pluxel/runtime/workbench/client': runtime,
		'@pluxel/runtime/workbench/react': runtime,
		'@pluxel/runtime/internal/workbench-react': runtime,
	}) satisfies Readonly<Record<WorkbenchFederationSharedModule, string>>
	return Object.freeze({
		profile: WORKBENCH_PROFILE_VERSION,
		buildContract: WORKBENCH_FEDERATION_BUILD_CONTRACT_VERSION,
		moduleFederation: Object.freeze({
			vite: WORKBENCH_FEDERATION_VITE_VERSION,
			runtime: WORKBENCH_FEDERATION_RUNTIME_VERSION,
			bridgeReact: WORKBENCH_FEDERATION_REACT_BRIDGE_VERSION,
		}),
		shared,
	})
}

const WORKBENCH_ENTRY_KEY = /^[A-Za-z][A-Za-z0-9_]{0,127}$/
const WORKBENCH_BUILD_REVISION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const RESERVED_ENTRY_KEYS = new Set(['__proto__', 'prototype', 'constructor', 'then'])
const canonicalDeclarationIdentities = new WeakSet<object>()
const canonicalPlacementIdentities = new WeakSet<object>()

export function parseWorkbenchDeclarationIdentity(input: unknown): WorkbenchDeclarationIdentity {
	if (typeof input === 'object' && input !== null && canonicalDeclarationIdentities.has(input)) {
		return input as WorkbenchDeclarationIdentity
	}
	const record = readExactRecord(input, 'declaration identity', ['kind', 'owner', 'key'])
	if (record.kind !== 'view' && record.kind !== 'attachment') {
		throw new TypeError(
			'[pluxel/core/federation] declaration identity kind must be view or attachment',
		)
	}
	const identity = Object.freeze({
		kind: record.kind,
		owner: parsePluginDefinitionAddress(record.owner),
		key: readEntryKey(record.key, 'declaration identity key'),
	}) as WorkbenchDeclarationIdentity
	canonicalDeclarationIdentities.add(identity)
	return identity
}

export function parseWorkbenchOpenableIdentity(input: unknown): WorkbenchOpenableIdentity {
	if (typeof input === 'object' && input !== null && canonicalPlacementIdentities.has(input)) {
		return input as WorkbenchAttachmentPlacementIdentity
	}
	const record = readRecord(input, 'openable identity')
	if (record.kind === 'view') {
		const declaration = parseWorkbenchDeclarationIdentity(record)
		if (declaration.kind !== 'view') throw new TypeError('unreachable Workbench identity state')
		return declaration
	}
	if (record.kind === 'page') {
		assertExactKeys(record, 'Page identity', ['kind', 'owner', 'key'])
		return Object.freeze({
			kind: 'page',
			owner: parsePluginDefinitionAddress(record.owner),
			key: readEntryKey(record.key, 'Page identity key'),
		})
	}
	if (record.kind !== 'attachment-placement') {
		throw new TypeError(
			'[pluxel/core/federation] openable identity kind must be view, page, or attachment-placement',
		)
	}
	assertExactKeys(record, 'attachment placement identity', ['kind', 'consumer', 'key', 'provider'])
	const provider = parseWorkbenchDeclarationIdentity(record.provider)
	if (provider.kind !== 'attachment') {
		throw new TypeError(
			'[pluxel/core/federation] attachment placement provider must be an attachment declaration',
		)
	}
	const identity: WorkbenchAttachmentPlacementIdentity = Object.freeze({
		kind: 'attachment-placement',
		consumer: parsePluginDefinitionAddress(record.consumer),
		key: readEntryKey(record.key, 'attachment placement key'),
		provider,
	})
	canonicalPlacementIdentities.add(identity)
	return identity
}

export function workbenchDeclarationIdentityEqual(
	left: WorkbenchDeclarationIdentity,
	right: WorkbenchDeclarationIdentity,
): boolean {
	const canonicalLeft = parseWorkbenchDeclarationIdentity(left)
	const canonicalRight = parseWorkbenchDeclarationIdentity(right)
	return (
		canonicalLeft.kind === canonicalRight.kind &&
		canonicalLeft.key === canonicalRight.key &&
		pluginDefinitionAddressEqual(canonicalLeft.owner, canonicalRight.owner)
	)
}

export function workbenchOpenableIdentityEqual(
	left: WorkbenchOpenableIdentity,
	right: WorkbenchOpenableIdentity,
): boolean {
	const canonicalLeft = parseWorkbenchOpenableIdentity(left)
	const canonicalRight = parseWorkbenchOpenableIdentity(right)
	if (
		canonicalLeft.kind === 'attachment-placement' ||
		canonicalRight.kind === 'attachment-placement'
	) {
		return (
			canonicalLeft.kind === 'attachment-placement' &&
			canonicalRight.kind === 'attachment-placement' &&
			canonicalLeft.key === canonicalRight.key &&
			pluginDefinitionAddressEqual(canonicalLeft.consumer, canonicalRight.consumer) &&
			workbenchDeclarationIdentityEqual(canonicalLeft.provider, canonicalRight.provider)
		)
	}
	return (
		canonicalLeft.kind === canonicalRight.kind &&
		canonicalLeft.key === canonicalRight.key &&
		pluginDefinitionAddressEqual(canonicalLeft.owner, canonicalRight.owner)
	)
}

export function createWorkbenchFederationProducerPlan(
	input: CreateWorkbenchFederationProducerPlanInput,
): WorkbenchFederationProducerPlan {
	const record = readExactRecord(input, 'producer plan input', [
		'definition',
		'buildRevision',
		'entries',
	])
	const definition = parsePluginDefinitionAddress(record.definition)
	const buildRevision = readBuildRevision(record.buildRevision)
	if (!Array.isArray(record.entries) || record.entries.length === 0) {
		throw new TypeError('[pluxel/core/federation] a producer must contain at least one entry')
	}

	const keys = new Set<string>()
	const exposes = new Set<string>()
	const entries = record.entries.map((entry, index): WorkbenchFederationProducerEntry => {
		const entryRecord = readExactRecord(entry, `entries[${index}]`, [
			'descriptor',
			'bridgeEntryPath',
		])
		const descriptor = readDescriptor(
			entryRecord.descriptor as WorkbenchFederationDescriptorIdentity,
			definition,
			index,
		)
		if (keys.has(descriptor.key)) {
			throw new TypeError(
				`[pluxel/core/federation] duplicate Workbench entry key: ${descriptor.key}`,
			)
		}
		keys.add(descriptor.key)

		const expose = workbenchFederationExpose(descriptor.key)
		if (exposes.has(expose)) {
			throw new TypeError(`[pluxel/core/federation] duplicate expose: ${expose}`)
		}
		exposes.add(expose)

		const bridgeEntryPath = readRelativeSourcePath(
			entryRecord.bridgeEntryPath,
			`entries[${index}].bridgeEntryPath`,
		)
		return Object.freeze({ descriptor, expose, bridgeEntryPath })
	})

	entries.sort((left, right) => left.expose.localeCompare(right.expose))
	return Object.freeze({
		profile: WORKBENCH_PROFILE_VERSION,
		definition,
		buildRevision,
		producer: workbenchFederationProducerName(definition),
		entries: Object.freeze(entries),
	})
}

/** Canonicalizes an untrusted producer plan at a server/toolchain boundary. */
export function parseWorkbenchFederationProducerPlan(
	input: unknown,
): WorkbenchFederationProducerPlan {
	const record = readExactRecord(input, 'producer plan', [
		'profile',
		'definition',
		'buildRevision',
		'producer',
		'entries',
	])
	if (record.profile !== WORKBENCH_PROFILE_VERSION || !Array.isArray(record.entries)) {
		throw new TypeError('[pluxel/core/federation] producer plan profile/entries are invalid')
	}
	const entries = record.entries.map((entry, index) => {
		const item = readExactRecord(entry, `producer plan entries[${index}]`, [
			'descriptor',
			'expose',
			'bridgeEntryPath',
		])
		return {
			descriptor: item.descriptor as WorkbenchFederationDescriptorIdentity,
			bridgeEntryPath: item.bridgeEntryPath as string,
			expose: item.expose,
		}
	})
	const canonical = createWorkbenchFederationProducerPlan({
		definition: record.definition as PluginDefinitionAddress,
		buildRevision: record.buildRevision as string,
		entries: entries.map(({ descriptor, bridgeEntryPath }) => ({
			descriptor,
			bridgeEntryPath,
		})),
	})
	if (
		record.producer !== canonical.producer ||
		entries.length !== canonical.entries.length ||
		entries.some(
			(entry, index) =>
				entry.expose !== canonical.entries[index]?.expose ||
				entry.bridgeEntryPath !== canonical.entries[index]?.bridgeEntryPath,
		)
	) {
		throw new TypeError('[pluxel/core/federation] producer plan is not canonical')
	}
	return canonical
}

/**
 * Validates the standard MF Manifest fields owned by Workbench Profile 1.
 *
 * The returned file inventory is the minimum Manifest-declared set a candidate must contain.
 * A host additionally pins the producer root's complete regular-file output closure because MF
 * remote-entry implementation chunks are not guaranteed to appear in Manifest asset arrays.
 * Snapshot generation remains an SDK operation; pass its result to
 * `assertWorkbenchFederationSnapshotContract()` before publishing the candidate.
 */
export function parseWorkbenchFederationManifestContract(
	input: unknown,
	expected: WorkbenchFederationManifestExpectation,
): WorkbenchFederationManifestContract {
	const plan = parseWorkbenchFederationProducerPlan(expected?.plan)
	assertWorkbenchFederationCompatibilitySet(expected?.compatibility)
	const manifest = readRecord(input, 'federation manifest')
	const metaData = readRecord(manifest.metaData, 'federation manifest.metaData')
	if (
		manifest.id !== plan.producer ||
		manifest.name !== plan.producer ||
		metaData.name !== plan.producer
	) {
		throw new TypeError(`federation manifest producer must be ${plan.producer}`)
	}
	if (metaData.publicPath !== 'auto' || 'getPublicPath' in metaData) {
		throw new TypeError('federation manifest publicPath must be exactly auto')
	}
	const remoteEntry = readRecord(metaData.remoteEntry, 'federation manifest.metaData.remoteEntry')
	if (
		remoteEntry.name !== WORKBENCH_FEDERATION_REMOTE_ENTRY_FILE ||
		remoteEntry.path !== '' ||
		remoteEntry.type !== 'module'
	) {
		throw new TypeError(
			`federation manifest remote entry must be ${WORKBENCH_FEDERATION_REMOTE_ENTRY_FILE}`,
		)
	}

	const exposes = readArray(manifest.exposes, 'federation manifest.exposes')
	const actualExposes = new Map<string, Record<string, unknown>>()
	for (const [index, rawExpose] of exposes.entries()) {
		const expose = readRecord(rawExpose, `federation manifest.exposes[${index}]`)
		const name = normalizeWorkbenchFederationExpose(expose.name)
		if (!name || actualExposes.has(name)) {
			throw new TypeError('federation manifest contains an invalid expose')
		}
		if (normalizeWorkbenchFederationExpose(expose.path) !== name) {
			throw new TypeError(`federation manifest expose path mismatch: ${name}`)
		}
		actualExposes.set(name, expose)
	}
	const expectedExposes = new Set(plan.entries.map((entry) => entry.expose))
	if (
		actualExposes.size !== expectedExposes.size ||
		[...actualExposes.keys()].some((name) => !expectedExposes.has(name as `./views/${string}`))
	) {
		throw new TypeError('federation manifest expose inventory mismatch')
	}

	const files = new Set<string>([
		WORKBENCH_FEDERATION_MANIFEST_FILE,
		WORKBENCH_FEDERATION_REMOTE_ENTRY_FILE,
	])
	for (const expose of actualExposes.values()) {
		collectWorkbenchFederationAssets(expose.assets, files)
	}

	const shared = readArray(manifest.shared, 'federation manifest.shared')
	const actualShared = new Map<string, Record<string, unknown>>()
	for (const [index, rawShared] of shared.entries()) {
		const item = readRecord(rawShared, `federation manifest.shared[${index}]`)
		if (typeof item.name !== 'string' || !item.name || actualShared.has(item.name)) {
			throw new TypeError('federation manifest contains an invalid shared entry')
		}
		actualShared.set(item.name, item)
	}
	const expectedShared = expected.compatibility.shared
	if (
		actualShared.size !== WORKBENCH_FEDERATION_SHARED_MODULES.length ||
		WORKBENCH_FEDERATION_SHARED_MODULES.some((name) => !actualShared.has(name))
	) {
		throw new TypeError('federation manifest shared inventory mismatch')
	}
	for (const name of WORKBENCH_FEDERATION_SHARED_MODULES) {
		const item = actualShared.get(name)!
		const version = expectedShared[name]
		if (item.version !== version || item.requiredVersion !== version || item.singleton !== true) {
			throw new TypeError(
				`federation manifest shared contract mismatch for ${name}: expected exact singleton ${version}`,
			)
		}
		collectWorkbenchFederationAssets(item.assets, files)
	}

	const types = readRecord(metaData.types, 'federation manifest.metaData.types')
	for (const field of ['api', 'zip'] as const) {
		const file = normalizeWorkbenchFederationAssetPath(types[field])
		if (!file) {
			throw new TypeError(`federation manifest type asset is invalid: ${field}`)
		}
		files.add(file)
	}
	return Object.freeze({ files: Object.freeze([...files]) })
}

/** Validates the standard SDK Snapshot against the exact producer expose inventory. */
export function assertWorkbenchFederationSnapshotContract(
	input: unknown,
	planInput: WorkbenchFederationProducerPlan,
): void {
	const plan = parseWorkbenchFederationProducerPlan(planInput)
	const snapshot = readRecord(input, 'federation Snapshot')
	const modules = readArray(snapshot.modules, 'federation Snapshot.modules')
	const actual = new Set<string>()
	for (const [index, rawModule] of modules.entries()) {
		const module = readRecord(rawModule, `federation Snapshot.modules[${index}]`)
		const name = normalizeWorkbenchFederationExpose(module.moduleName)
		if (!name || actual.has(name)) {
			throw new TypeError('federation Snapshot contains an invalid module')
		}
		actual.add(name)
	}
	const expected: ReadonlySet<string> = new Set(plan.entries.map((entry) => entry.expose))
	if (actual.size !== expected.size || [...actual].some((name) => !expected.has(name))) {
		throw new TypeError('federation Snapshot module inventory mismatch')
	}
}

export function createWorkbenchFederationDeploymentInventory(
	plans: readonly WorkbenchFederationProducerPlan[],
): WorkbenchFederationDeploymentInventory {
	if (!Array.isArray(plans)) {
		throw new TypeError('[pluxel/core/federation] deployment plans must be an array')
	}
	const producers = plans.map((plan) => {
		const canonical = parseWorkbenchFederationProducerPlan(plan)
		return Object.freeze({
			plan: canonical,
			artifactRoot: workbenchFederationBuildOutDir(canonical, ''),
		})
	})
	producers.sort((left, right) => left.plan.producer.localeCompare(right.plan.producer))
	for (let index = 1; index < producers.length; index += 1) {
		if (producers[index - 1]!.plan.producer === producers[index]!.plan.producer) {
			throw new TypeError(
				`[pluxel/core/federation] duplicate deployment producer: ${producers[index]!.plan.producer}`,
			)
		}
	}
	return Object.freeze({
		version: WORKBENCH_FEDERATION_PRODUCER_INVENTORY_VERSION,
		profile: WORKBENCH_PROFILE_VERSION,
		buildContract: WORKBENCH_FEDERATION_BUILD_CONTRACT_VERSION,
		producers: Object.freeze(producers),
	})
}

/** Parses the host-owned deployment inventory without reading or copying MF Manifest fields. */
export function parseWorkbenchFederationDeploymentInventory(
	input: unknown,
): WorkbenchFederationDeploymentInventory {
	const record = readExactRecord(input, 'deployment inventory', [
		'version',
		'profile',
		'buildContract',
		'producers',
	])
	if (
		record.version !== WORKBENCH_FEDERATION_PRODUCER_INVENTORY_VERSION ||
		record.profile !== WORKBENCH_PROFILE_VERSION ||
		record.buildContract !== WORKBENCH_FEDERATION_BUILD_CONTRACT_VERSION ||
		!Array.isArray(record.producers)
	) {
		throw new TypeError('[pluxel/core/federation] deployment inventory version is invalid')
	}
	const plans = record.producers.map((producer, index) => {
		const item = readExactRecord(producer, `deployment producers[${index}]`, [
			'plan',
			'artifactRoot',
		])
		const plan = parseWorkbenchFederationProducerPlan(item.plan)
		const artifactRoot = readRelativeSourcePath(
			item.artifactRoot,
			`deployment producers[${index}].artifactRoot`,
		)
		const expectedRoot = workbenchFederationBuildOutDir(plan, '')
		if (artifactRoot !== expectedRoot) {
			throw new TypeError(
				`[pluxel/core/federation] deployment producer artifactRoot must be ${expectedRoot}`,
			)
		}
		return plan
	})
	const canonical = createWorkbenchFederationDeploymentInventory(plans)
	for (let index = 0; index < canonical.producers.length; index += 1) {
		const raw = record.producers[index] as Record<string, unknown>
		if (raw.artifactRoot !== canonical.producers[index]?.artifactRoot) {
			throw new TypeError(
				'[pluxel/core/federation] deployment producers must be canonically sorted',
			)
		}
		const rawPlan = raw.plan as Record<string, unknown>
		if (rawPlan.producer !== canonical.producers[index]?.plan.producer) {
			throw new TypeError(
				'[pluxel/core/federation] deployment producers must be canonically sorted',
			)
		}
	}
	return canonical
}

export function workbenchFederationDeploymentInventoryPath(
	baseDir: string = WORKBENCH_FEDERATION_BUILD_ROOT,
): string {
	const base = normalizeRelativeRoot(baseDir)
	return [base, WORKBENCH_FEDERATION_OUT_DIR, WORKBENCH_FEDERATION_PRODUCER_INVENTORY_FILE]
		.filter(Boolean)
		.join('/')
}

export function workbenchFederationProducerName(definition: PluginDefinitionAddress): string {
	const canonical = parsePluginDefinitionAddress(definition)
	return `pluxel_workbench_${stableAddressDigest(encodePluginDefinitionAddressBytes(canonical))}`
}

export function workbenchFederationExpose(key: string): `./views/${string}` {
	const canonicalKey = readEntryKey(key, 'entry key')
	return `./views/${canonicalKey}`
}

export function workbenchFederationModuleId(expose: `./views/${string}`): string {
	return expose.slice(2)
}

export function workbenchFederationBuildOutDir(
	plan: Pick<WorkbenchFederationProducerPlan, 'producer' | 'buildRevision'>,
	baseDir: string = WORKBENCH_FEDERATION_BUILD_ROOT,
): string {
	const base = normalizeRelativeRoot(baseDir)
	const producer = readSafeSegment(plan.producer, 'producer')
	const revision = readBuildRevision(plan.buildRevision)
	return [base, WORKBENCH_FEDERATION_OUT_DIR, producer, revision].filter(Boolean).join('/')
}

export function workbenchFederationManifestPath(
	plan: Pick<WorkbenchFederationProducerPlan, 'producer' | 'buildRevision'>,
	baseDir: string = WORKBENCH_FEDERATION_BUILD_ROOT,
): string {
	return `${workbenchFederationBuildOutDir(plan, baseDir)}/${WORKBENCH_FEDERATION_MANIFEST_FILE}`
}

function assertWorkbenchFederationCompatibilitySet(
	input: WorkbenchFederationCompatibilitySet,
): void {
	const record = readExactRecord(input, 'federation compatibility set', [
		'profile',
		'buildContract',
		'moduleFederation',
		'shared',
	])
	if (
		record.profile !== WORKBENCH_PROFILE_VERSION ||
		record.buildContract !== WORKBENCH_FEDERATION_BUILD_CONTRACT_VERSION
	) {
		throw new TypeError('federation compatibility profile/build contract is invalid')
	}
	const moduleFederation = readExactRecord(
		record.moduleFederation,
		'federation compatibility moduleFederation',
		['vite', 'runtime', 'bridgeReact'],
	)
	if (
		moduleFederation.vite !== WORKBENCH_FEDERATION_VITE_VERSION ||
		moduleFederation.runtime !== WORKBENCH_FEDERATION_RUNTIME_VERSION ||
		moduleFederation.bridgeReact !== WORKBENCH_FEDERATION_REACT_BRIDGE_VERSION
	) {
		throw new TypeError('federation compatibility Module Federation versions are invalid')
	}
	const shared = readExactRecord(
		record.shared,
		'federation compatibility shared versions',
		WORKBENCH_FEDERATION_SHARED_MODULES,
	)
	for (const name of WORKBENCH_FEDERATION_SHARED_MODULES) {
		readNonEmptyText(shared[name], `federation compatibility shared version ${name}`)
	}
}

function collectWorkbenchFederationAssets(input: unknown, files: Set<string>): void {
	const group = readRecord(input, 'federation manifest asset group')
	for (const kind of ['js', 'css'] as const) {
		const assets = readRecord(group[kind], `federation manifest ${kind} assets`)
		for (const phase of ['sync', 'async'] as const) {
			for (const rawFile of readArray(
				assets[phase],
				`federation manifest ${kind}.${phase} assets`,
			)) {
				const file = normalizeWorkbenchFederationAssetPath(rawFile)
				if (!file) throw new TypeError('federation manifest asset path is invalid')
				files.add(file)
			}
		}
	}
}

function normalizeWorkbenchFederationExpose(input: unknown): `./views/${string}` | null {
	if (typeof input !== 'string' || !input) return null
	const value = input.startsWith('./') ? input : `./${input.replace(/^\/+/, '')}`
	return value.startsWith('./views/') && normalizeWorkbenchFederationAssetPath(value.slice(2))
		? (value as `./views/${string}`)
		: null
}

function normalizeWorkbenchFederationAssetPath(input: unknown): string | null {
	if (
		typeof input !== 'string' ||
		!input ||
		input.startsWith('/') ||
		input.includes('\\') ||
		input.includes('\0') ||
		input.includes('?') ||
		input.includes('#') ||
		/^[A-Za-z][A-Za-z\d+.-]*:/.test(input)
	) {
		return null
	}
	const value = input.startsWith('./') ? input.slice(2) : input
	const segments = value.split('/')
	if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return null
	return segments.join('/')
}

function readDescriptor(
	input: WorkbenchFederationDescriptorIdentity,
	definition: PluginDefinitionAddress,
	index: number,
): WorkbenchFederationDescriptorIdentity {
	const descriptor = parseWorkbenchDeclarationIdentity(input)
	const owner = descriptor.owner
	if (!pluginDefinitionAddressEqual(owner, definition)) {
		throw new TypeError(
			`[pluxel/core/federation] entries[${index}] belongs to a different Plugin definition`,
		)
	}
	return descriptor
}

function readEntryKey(input: unknown, label: string): string {
	const value = readNonEmptyText(input, label)
	if (!WORKBENCH_ENTRY_KEY.test(value) || RESERVED_ENTRY_KEYS.has(value)) {
		throw new TypeError(
			`[pluxel/core/federation] ${label} must match ${WORKBENCH_ENTRY_KEY.source} and not be reserved`,
		)
	}
	return value
}

function readBuildRevision(input: unknown): string {
	const value = readNonEmptyText(input, 'buildRevision')
	if (!WORKBENCH_BUILD_REVISION.test(value)) {
		throw new TypeError(
			`[pluxel/core/federation] buildRevision must match ${WORKBENCH_BUILD_REVISION.source}`,
		)
	}
	return value
}

function readSafeSegment(input: unknown, label: string): string {
	const value = readNonEmptyText(input, label)
	if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) {
		throw new TypeError(`[pluxel/core/federation] ${label} is not a safe path segment`)
	}
	return value
}

function readNonEmptyText(input: unknown, label: string): string {
	if (typeof input !== 'string' || input.length === 0 || input.trim() !== input) {
		throw new TypeError(
			`[pluxel/core/federation] ${label} must be a non-empty string without surrounding whitespace`,
		)
	}
	return input
}

function readRelativeSourcePath(input: unknown, label: string): string {
	const value = readNonEmptyText(input, label)
	if (
		value.startsWith('/') ||
		value.startsWith('\\') ||
		/^[A-Za-z]:[\\/]/.test(value) ||
		value.includes('\\') ||
		value.includes('?') ||
		value.includes('#') ||
		value.split('/').some((segment) => !segment || segment === '.' || segment === '..')
	) {
		throw new TypeError(`[pluxel/core/federation] ${label} must be a normalized relative path`)
	}
	return value
}

function readRecord(input: unknown, label: string): Record<string, unknown> {
	if (!input || typeof input !== 'object' || Array.isArray(input)) {
		throw new TypeError(`[pluxel/core/federation] ${label} must be an object`)
	}
	return input as Record<string, unknown>
}

function readArray(input: unknown, label: string): unknown[] {
	if (!Array.isArray(input)) {
		throw new TypeError(`[pluxel/core/federation] ${label} must be an array`)
	}
	return input
}

function readExactRecord(
	input: unknown,
	label: string,
	keys: readonly string[],
): Record<string, unknown> {
	const record = readRecord(input, label)
	assertExactKeys(record, label, keys)
	return record
}

function assertExactKeys(
	record: Record<string, unknown>,
	label: string,
	keys: readonly string[],
): void {
	const expected = new Set(keys)
	const actual = Object.keys(record)
	if (actual.length !== expected.size || actual.some((key) => !expected.has(key))) {
		throw new TypeError(`[pluxel/core/federation] ${label} must contain exactly ${keys.join(', ')}`)
	}
}

function normalizeRelativeRoot(input: string): string {
	const raw = String(input ?? '')
	if (raw.startsWith('/') || raw.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(raw)) {
		throw new TypeError('[pluxel/core/federation] build root must be relative')
	}
	const value = raw.replaceAll('\\', '/').replaceAll(/^\/+|\/+$/g, '')
	if (!value) return ''
	if (value.split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
		throw new TypeError('[pluxel/core/federation] build root must be a normalized relative path')
	}
	return value
}

// A compact deterministic 128-bit identity. The semantic inventory independently
// rejects duplicate producer names, so a digest can never silently alias producers.
function stableAddressDigest(bytes: Uint8Array): string {
	const mask = 0xffff_ffff_ffff_ffffn
	const prime = 0x0000_0100_0000_01b3n
	let left = 0xcbf2_9ce4_8422_2325n
	let right = 0x8422_2325_cbf2_9ce4n
	for (let index = 0; index < bytes.length; index += 1) {
		const byte = BigInt(bytes[index]!)
		left = ((left ^ byte) * prime) & mask
		right = ((right ^ (byte + BigInt(index & 0xff))) * prime) & mask
	}
	return `${left.toString(16).padStart(16, '0')}${right.toString(16).padStart(16, '0')}`
}
