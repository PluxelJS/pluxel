import {
	parsePluginDefinitionAddress,
	parsePluginNodeAddress,
	type Context,
	type PluginDefinitionAddress,
	type PluginNodeAddress,
} from '@pluxel/core'
import { RpcTarget, type RpcStub } from 'capnweb'
import {
	readPluginCatalog,
	writePluginCatalogLayout,
} from '../../api/features/pluginCatalog/service'
import { PluginCatalogLayoutError } from './PluginCatalogLayoutService'
import { PersistenceError } from '../persistence/PersistenceService'
import {
	pluginConfigGet,
	pluginConfigPatch,
	pluginConfigPatchField,
	pluginConfigPresentation,
} from '../../api/usecases/pluginConfig'
import {
	inspectPluginConsumerRequirements,
	inspectPluginProviderPolicy,
	PluginNodeUnavailableError,
	setPluginConsumerOverride as applyPluginConsumerOverride,
	setPluginProviderPolicyDefault as applyPluginProviderPolicyDefault,
} from '../../api/usecases/pluginDependencies'
import { pluginDependencyGraph } from '../../api/usecases/pluginDependencyGraph'
import { ensureFork, removeFork } from '../../api/usecases/pluginForks'
import { applyLifecycleCommands, setAutoStart } from '../../api/usecases/pluginStatus'
import { logsFollow, logsIndex, logsMeta, logsRange } from '../../api/usecases/logs'
import { pluginStatus as readPluginStatus } from '../../api/usecases/plugins'
import { projectPluginApplyReport } from '../../api/presenters/pluginApplyReport'
import { requireContextRuntimeLogging } from '../../logger/logging'
import type {
	PluginLogPolicyMutationResult,
	PluginLogPolicySnapshot,
	RuntimePluginLogLevel,
	VersionedPluginLogPolicySnapshot,
} from '../../logger/policy'
import type { LogFilter, RuntimeLogEvent } from '../../logger/protocol'
import { listSecurityEvents } from '../security/audit'
import type { VaultAdminApi } from '../vault/types'
import type {
	RuntimeLogFollowInput,
	RuntimeLogObserver,
	RuntimeLogSubscriptionTarget,
	RuntimeManagementTarget,
} from '../../web/management-target'
import type {
	ConfigResult,
	EnsureForkResult,
	RemoveForkResult,
	PluginConsumerRequirementsInspectionResult,
	PluginDependencyGraphSnapshot,
	PluginDependencyMutationResult,
	PluginProviderPolicyInspectionResult,
	PluginCatalogLayoutInput,
	PluginCatalogLayoutMutationResult,
	PluginCatalogSnapshot,
	PluginControlBatchResult,
	PluginStatusQueryResult,
} from '../../web/protocol'
import {
	parseConfigPresentationResult,
	parseConfigResult,
	parsePluginControlBatchResult,
} from '../../web/management-validation'

export class RuntimeManagementTargetImpl extends RpcTarget implements RuntimeManagementTarget {
	private readonly ctx: Context

	constructor(ctx: Context) {
		super()
		this.ctx = ctx
	}

	describe() {
		const management = this.ctx.root.runtimeManagement
		if (!management) throw new Error('Runtime Management is unavailable')
		return management.describe()
	}

	async pluginCatalog(): Promise<PluginCatalogSnapshot> {
		return await readPluginCatalog(this.ctx)
	}

	async pluginStatus(owner: unknown): Promise<PluginStatusQueryResult> {
		const address = parseRpcNode(owner)
		if (!address) {
			return {
				ok: false,
				code: 'invalid_input',
				state: 'unchanged',
				error: 'Invalid Plugin node address',
			}
		}
		return { ok: true, value: await readPluginStatus(this.ctx, address) }
	}

	async updatePluginCatalogLayout(input: unknown): Promise<PluginCatalogLayoutMutationResult> {
		const parsed = parseRpcPluginCatalogLayout(input)
		if (parsed.ok === false) {
			return {
				ok: false,
				code: 'invalid_input',
				state: 'unchanged',
				error: parsed.error,
			}
		}
		try {
			return { ok: true, sections: await writePluginCatalogLayout(this.ctx, parsed.value) }
		} catch (error) {
			if (error instanceof PluginCatalogLayoutError) {
				return {
					ok: false,
					code: 'mutation_rejected',
					state: 'unchanged',
					error: error.message,
				}
			}
			if (error instanceof PersistenceError) {
				return {
					ok: false,
					code: 'persistence_failed',
					state: 'unknown',
					error: error.message,
				}
			}
			throw error
		}
	}

	async pluginConfigPresentation(owner: unknown) {
		const address = parseRpcNode(owner)
		if (!address) {
			return {
				ok: false as const,
				code: 'invalid_input' as const,
				message: 'Invalid Plugin node address',
			}
		}
		return parseConfigPresentationResult(await pluginConfigPresentation(this.ctx, address))
	}

	async pluginConfig(owner: unknown): Promise<ConfigResult> {
		const address = parseRpcNode(owner)
		if (!address) return invalidConfigInput('Invalid Plugin node address')
		return parseConfigResult(await pluginConfigGet(this.ctx, address))
	}

	async patchPluginConfig(owner: unknown, patch: unknown): Promise<ConfigResult> {
		const address = parseRpcNode(owner)
		if (!address) return invalidConfigInput('Invalid Plugin node address')
		const record = readRpcRecord(patch)
		if (!record) return invalidConfigInput('Config patch must be an object')
		return parseConfigResult(await pluginConfigPatch(this.ctx, address, record))
	}

	async patchPluginConfigField(owner: unknown, input: unknown): Promise<ConfigResult> {
		const address = parseRpcNode(owner)
		if (!address) return invalidConfigInput('Invalid Plugin node address')
		if (!readRpcRecord(input)) return invalidConfigInput('Config field mutation must be an object')
		return parseConfigResult(await pluginConfigPatchField(this.ctx, address, input))
	}

	async pluginDependencyGraph(): Promise<PluginDependencyGraphSnapshot> {
		return await pluginDependencyGraph(this.ctx)
	}

	async inspectPluginConsumerRequirements(
		consumer: unknown,
	): Promise<PluginConsumerRequirementsInspectionResult> {
		const address = parseRpcNode(consumer)
		if (!address) return invalidDependencyInput('Invalid Plugin node address')
		try {
			return { ok: true, items: inspectPluginConsumerRequirements(this.ctx, address) }
		} catch (error) {
			return unavailableConsumerRequirementsQuery(error)
		}
	}

	async setPluginConsumerOverride(input: unknown): Promise<PluginDependencyMutationResult> {
		const record = readRpcRecord(input)
		const consumer = parseRpcNode(record?.consumer)
		const requirement = parseRpcDefinition(record?.requirement)
		const provider = parseRpcNullableNode(record?.provider)
		if (
			!record ||
			!hasExactKeys(record, ['consumer', 'requirement', 'provider']) ||
			!consumer ||
			!requirement ||
			!provider.ok
		) {
			return invalidDependencyInput('Invalid consumer override input')
		}
		return await applyPluginConsumerOverride(this.ctx, consumer, requirement, provider.value)
	}

	async inspectPluginProviderPolicy(
		policyOwner: unknown,
	): Promise<PluginProviderPolicyInspectionResult> {
		const address = parseRpcNode(policyOwner)
		if (!address) return invalidDependencyInput('Invalid Plugin node address')
		try {
			return { ok: true, value: inspectPluginProviderPolicy(this.ctx, address) }
		} catch (error) {
			return unavailableProviderPolicyQuery(error)
		}
	}

	async setPluginProviderPolicyDefault(input: unknown): Promise<PluginDependencyMutationResult> {
		const record = readRpcRecord(input)
		const policyOwner = parseRpcNode(record?.policyOwner)
		const provider = parseRpcNullableNode(record?.provider)
		if (
			!record ||
			!hasExactKeys(record, ['policyOwner', 'provider']) ||
			!policyOwner ||
			!provider.ok
		) {
			return invalidDependencyInput('Invalid provider policy input')
		}
		return await applyPluginProviderPolicyDefault(this.ctx, policyOwner, provider.value)
	}

	async ensurePluginFork(input: unknown): Promise<EnsureForkResult> {
		const record = readRpcRecord(input)
		const base = parseRpcNode(record?.base)
		const selectFor = parseRpcForkSelection(record?.selectFor)
		if (
			!record ||
			!hasOnlyKeys(record, ['base', 'forkId', 'autoStart', 'selectFor']) ||
			!base ||
			typeof record.forkId !== 'string' ||
			(record.autoStart !== undefined && typeof record.autoStart !== 'boolean') ||
			!selectFor.ok
		) {
			return {
				ok: false,
				code: 'invalid_input',
				state: 'unchanged',
				error: 'Invalid fork input',
			}
		}
		const result = await ensureFork(this.ctx, base, record.forkId, {
			autoStart: record.autoStart as boolean | undefined,
			...(selectFor.value === undefined ? {} : { selectFor: selectFor.value }),
		})
		if (result.ok === true) {
			return {
				ok: true,
				status: result.status,
				fork: parsePluginNodeAddress(result.node),
				report: projectPluginApplyReport(this.ctx, result.report),
			}
		}
		if (result.code === 'persistence_failed') {
			return {
				ok: false,
				code: result.code,
				state: result.state,
				error: result.message,
			}
		}
		return {
			ok: false,
			code: result.code,
			state: result.state,
			error: result.message,
		}
	}

	async removePluginFork(input: unknown): Promise<RemoveForkResult> {
		const record = readRpcRecord(input)
		const base = parseRpcNode(record?.base)
		if (
			!record ||
			!hasExactKeys(record, ['base', 'forkId']) ||
			!base ||
			typeof record.forkId !== 'string'
		) {
			return {
				ok: false,
				code: 'invalid_input',
				state: 'unchanged',
				error: 'Invalid fork removal input',
			}
		}
		const result = await removeFork(this.ctx, base, record.forkId)
		if (result.ok === true) {
			if (result.status === 'already-absent') {
				return {
					ok: true,
					status: result.status,
					fork: parsePluginNodeAddress(result.node),
				}
			}
			return {
				ok: true,
				status: result.status,
				fork: parsePluginNodeAddress(result.node),
				report: projectPluginApplyReport(this.ctx, result.report),
			}
		}
		if (result.code === 'fork_referenced') {
			return {
				ok: false,
				code: result.code,
				state: result.state,
				references: Object.freeze(
					result.references.map((reference) =>
						Object.freeze({
							consumer: parsePluginNodeAddress(reference.consumer),
							requirement: parsePluginDefinitionAddress(reference.requirement),
						}),
					),
				),
				error: result.message,
			}
		}
		if (result.code === 'persistence_failed') {
			return {
				ok: false,
				code: result.code,
				state: result.state,
				fork: parsePluginNodeAddress(result.node),
				...(result.report ? { report: projectPluginApplyReport(this.ctx, result.report) } : {}),
				error: result.message,
			}
		}
		return {
			ok: false,
			code: result.code,
			state: result.state,
			error: result.message,
		}
	}

	async setPluginAutoStart(items: unknown): Promise<PluginControlBatchResult> {
		return parsePluginControlBatchResult(await setAutoStart(this.ctx, items))
	}

	async applyPluginLifecycleCommands(items: unknown): Promise<PluginControlBatchResult> {
		return parsePluginControlBatchResult(await applyLifecycleCommands(this.ctx, items))
	}

	async getLogPolicy(): Promise<VersionedPluginLogPolicySnapshot> {
		const logging = requireContextRuntimeLogging(this.ctx)
		await logging.ready
		return logging.policy.describe()
	}

	async replaceLogPolicy(
		expectedRevision: number,
		snapshot: PluginLogPolicySnapshot,
	): Promise<PluginLogPolicyMutationResult> {
		const policy = await this.logPolicy(expectedRevision)
		return policy.replace(snapshot)
	}

	async setDefaultLogLevel(
		expectedRevision: number,
		level: RuntimePluginLogLevel,
	): Promise<PluginLogPolicyMutationResult> {
		const policy = await this.logPolicy(expectedRevision)
		return policy.setDefaultLevel(level)
	}

	async setPluginLogLevel(
		expectedRevision: number,
		owner: PluginNodeAddress,
		level: RuntimePluginLogLevel,
	): Promise<PluginLogPolicyMutationResult> {
		const policy = await this.logPolicy(expectedRevision)
		return policy.setPluginLevel(owner, level)
	}

	async clearPluginLogLevel(
		expectedRevision: number,
		owner: PluginNodeAddress,
	): Promise<PluginLogPolicyMutationResult> {
		const policy = await this.logPolicy(expectedRevision)
		return policy.clearPluginLevel(owner)
	}

	async resetLogPolicy(expectedRevision: number): Promise<VersionedPluginLogPolicySnapshot> {
		const policy = await this.logPolicy(expectedRevision)
		policy.reset()
		return policy.describe()
	}

	logStreams() {
		return logsIndex()
	}

	logMeta(streamId: unknown) {
		return logsMeta({ streamId: parseLogStreamId(streamId) })
	}

	logRange(streamId: unknown, query: unknown) {
		const input = parseLogRangeInput(streamId, query)
		return logsRange(input)
	}

	async followLogs(
		input: unknown,
		observer: RuntimeLogObserver,
	): Promise<RuntimeLogSubscriptionTarget> {
		return new RuntimeLogSubscription(
			parseLogFollowInput(input),
			observer as RpcStub<RuntimeLogObserver>,
		)
	}

	async securityOverview() {
		const adminAccess = this.ctx.root.adminAccess
		if (!adminAccess) throw new Error('Runtime Management authentication is unavailable')
		const vault = this.ctx.root.vaultAdmin
		return Object.freeze({
			adminAccess: await adminAccess.describe(),
			vault: vault
				? Object.freeze({ enabled: true as const, state: await vault.describe() })
				: Object.freeze({ enabled: false as const }),
		})
	}

	securityEvents(limit?: unknown) {
		return Object.freeze(listSecurityEvents(this.ctx, parseSecurityEventLimit(limit)))
	}

	async vaultUnlock() {
		return await this.vaultAdmin().unlock()
	}

	async vaultEnsureHostKey() {
		return Object.freeze({ publicKey: await this.vaultAdmin().ensureHostKey() })
	}

	async vaultGenerateDeployKey() {
		return await this.vaultAdmin().generateDeployKey()
	}

	async vaultSetDeployRecipients(publicKeys: unknown) {
		return await this.vaultAdmin().setDeployRecipients(parseDeployRecipients(publicKeys))
	}

	private async logPolicy(expectedRevision: number) {
		const logging = requireContextRuntimeLogging(this.ctx)
		await logging.ready
		logging.policy.assertRevision(expectedRevision)
		return logging.policy
	}

	private vaultAdmin(): VaultAdminApi {
		const vault = this.ctx.root.vaultAdmin
		if (!vault) throw new Error('Runtime Vault is unavailable')
		return vault
	}
}

const MAX_LOG_STREAM_ID = 256
const MAX_LOG_TEXT = 512
const MAX_LOG_RANGE_LINES = 20_000
const MAX_LOG_CALLBACK_LINES = 512
const MAX_LOG_CALLBACK_BYTES = 128 * 1024
const MAX_LOG_PENDING_EVENTS = 32
const MAX_LOG_PENDING_BYTES = 512 * 1024
const MAX_DEPLOY_RECIPIENTS = 1_000
const MAX_DEPLOY_RECIPIENT_LENGTH = 4_096

class RuntimeLogSubscription extends RpcTarget implements RuntimeLogSubscriptionTarget {
	private readonly observer: RpcStub<RuntimeLogObserver>
	private readonly unsubscribe: () => void
	private readonly queue: RuntimeLogEvent[] = []
	private queuedBytes = 0
	private draining = false
	private active = true

	constructor(input: RuntimeLogFollowInput, observer: RpcStub<RuntimeLogObserver>) {
		super()
		if (!observer || typeof observer !== 'function' || typeof observer.dup !== 'function') {
			throw new TypeError('Log observer must be an RPC callback')
		}
		this.observer = observer.dup()
		try {
			this.unsubscribe = logsFollow(input, (event) => this.enqueue(event))
		} catch (error) {
			this.observer[Symbol.dispose]()
			throw error
		}
	}

	[Symbol.dispose](): void {
		if (!this.active) return
		this.active = false
		this.unsubscribe()
		this.queue.length = 0
		this.queuedBytes = 0
		this.observer[Symbol.dispose]()
	}

	private enqueue(event: RuntimeLogEvent): void {
		if (!this.active) return
		if (event.type === 'reset') {
			this.queue.length = 0
			this.queuedBytes = 0
			this.push(event)
			this.startDrain()
			return
		}

		const bytes = encodedBytes(event)
		const oversized =
			bytes > MAX_LOG_CALLBACK_BYTES ||
			(event.type === 'append' && event.lines.length > MAX_LOG_CALLBACK_LINES)
		const overflow =
			this.queue.length >= MAX_LOG_PENDING_EVENTS ||
			this.queuedBytes + bytes > MAX_LOG_PENDING_BYTES
		if (oversized || overflow) {
			const gap = collapseLogGap(this.queue, event)
			this.queue.length = 0
			this.queuedBytes = 0
			this.push(gap)
		} else {
			this.push(event, bytes)
		}
		this.startDrain()
	}

	private push(event: RuntimeLogEvent, bytes = encodedBytes(event)): void {
		this.queue.push(event)
		this.queuedBytes += bytes
	}

	private startDrain(): void {
		if (this.draining) return
		this.draining = true
		void this.drain()
	}

	private async drain(): Promise<void> {
		try {
			while (this.active) {
				const event = this.queue.shift()
				if (!event) return
				this.queuedBytes = Math.max(0, this.queuedBytes - encodedBytes(event))
				const result = this.observer(event)
				try {
					await result
				} finally {
					result[Symbol.dispose]()
				}
			}
		} catch {
			this[Symbol.dispose]()
		} finally {
			this.draining = false
			if (this.active && this.queue.length > 0) this.startDrain()
		}
	}
}

function parseLogStreamId(input: unknown): string {
	if (typeof input !== 'string') throw new TypeError('Log streamId must be a string')
	const value = input.trim()
	if (!value || value.length > MAX_LOG_STREAM_ID) {
		throw new TypeError(`Log streamId must contain between 1 and ${MAX_LOG_STREAM_ID} characters`)
	}
	return value
}

function parseLogRangeInput(streamId: unknown, input: unknown) {
	const record = readRpcRecord(input)
	if (!record || !hasOnlyKeys(record, ['epoch', 'fromSeq', 'limit', 'filter'])) {
		throw new TypeError('Log range query must be a closed object')
	}
	if (!Number.isSafeInteger(record.epoch) || Number(record.epoch) <= 0) {
		throw new TypeError('Log range epoch must be a positive integer')
	}
	if (typeof record.fromSeq !== 'string' || !/^\d+$/.test(record.fromSeq)) {
		throw new TypeError('Log range fromSeq must be an unsigned integer string')
	}
	const limit =
		record.limit === undefined ? undefined : boundedInteger(record.limit, 1, MAX_LOG_RANGE_LINES)
	return Object.freeze({
		streamId: parseLogStreamId(streamId),
		epoch: Number(record.epoch),
		fromSeq: record.fromSeq,
		...(limit === undefined ? {} : { limit }),
		...(record.filter === undefined ? {} : { filter: parseLogFilter(record.filter) }),
	})
}

function parseLogFollowInput(input: unknown): RuntimeLogFollowInput {
	const record = readRpcRecord(input)
	if (
		!record ||
		!hasOnlyKeys(record, ['streamId', 'filter']) ||
		!Object.hasOwn(record, 'streamId')
	) {
		throw new TypeError('Log follow input must be a closed object with streamId')
	}
	return Object.freeze({
		streamId: parseLogStreamId(record.streamId),
		...(record.filter === undefined ? {} : { filter: parseLogFilter(record.filter) }),
	})
}

function parseLogFilter(input: unknown): LogFilter {
	const record = readRpcRecord(input)
	if (!record || !hasOnlyKeys(record, ['plugin', 'context', 'displayName', 'category'])) {
		throw new TypeError('Log filter must be a closed object')
	}
	const plugin = record.plugin === undefined ? undefined : parseRpcNode(record.plugin)
	if (record.plugin !== undefined && !plugin) throw new TypeError('Log filter plugin is invalid')
	return Object.freeze({
		...(plugin ? { plugin } : {}),
		...parseOptionalLogText(record, 'context'),
		...parseOptionalLogText(record, 'displayName'),
		...parseOptionalLogText(record, 'category'),
	})
}

function parseOptionalLogText<K extends 'context' | 'displayName' | 'category'>(
	record: Record<string, unknown>,
	key: K,
): Partial<Record<K, string>> {
	const input = record[key]
	if (input === undefined) return {}
	if (typeof input !== 'string') throw new TypeError(`Log filter ${key} must be a string`)
	const value = input.trim()
	if (!value || value.length > MAX_LOG_TEXT) {
		throw new TypeError(`Log filter ${key} must contain between 1 and ${MAX_LOG_TEXT} characters`)
	}
	return { [key]: value } as Partial<Record<K, string>>
}

function parseSecurityEventLimit(input: unknown): number {
	return input === undefined ? 40 : boundedInteger(input, 0, 200)
}

function parseDeployRecipients(input: unknown): string[] {
	if (!Array.isArray(input) || input.length > MAX_DEPLOY_RECIPIENTS) {
		throw new TypeError(
			`Vault deploy recipients must contain at most ${MAX_DEPLOY_RECIPIENTS} items`,
		)
	}
	const seen = new Set<string>()
	const recipients: string[] = []
	for (const [index, raw] of input.entries()) {
		if (typeof raw !== 'string')
			throw new TypeError(`Vault deploy recipient ${index} must be a string`)
		const value = raw.trim()
		if (!value || value.length > MAX_DEPLOY_RECIPIENT_LENGTH) {
			throw new TypeError(`Vault deploy recipient ${index} is invalid`)
		}
		if (!seen.has(value)) {
			seen.add(value)
			recipients.push(value)
		}
	}
	return recipients
}

function boundedInteger(input: unknown, min: number, max: number): number {
	if (!Number.isSafeInteger(input) || Number(input) < min || Number(input) > max) {
		throw new TypeError(`Expected an integer between ${min} and ${max}`)
	}
	return Number(input)
}

function encodedBytes(input: unknown): number {
	try {
		return new TextEncoder().encode(JSON.stringify(input)).byteLength
	} catch {
		return Number.POSITIVE_INFINITY
	}
}

function collapseLogGap(
	queued: readonly RuntimeLogEvent[],
	current: Exclude<RuntimeLogEvent, { type: 'reset' }>,
): RuntimeLogEvent {
	const candidates = [...queued, current].filter(
		(event): event is Exclude<RuntimeLogEvent, { type: 'reset' }> =>
			event.type !== 'reset' &&
			event.epoch === current.epoch &&
			event.streamId === current.streamId,
	)
	let from = logEventRange(candidates[0] ?? current).from
	let to = logEventRange(current).to
	for (const event of candidates) {
		const range = logEventRange(event)
		if (compareSequence(range.from, from) < 0) from = range.from
		if (compareSequence(range.to, to) > 0) to = range.to
	}
	return Object.freeze({
		type: 'gap',
		streamId: current.streamId,
		epoch: current.epoch,
		missingFrom: from,
		missingTo: to,
	})
}

function logEventRange(event: Exclude<RuntimeLogEvent, { type: 'reset' }>): {
	from: string
	to: string
} {
	if (event.type === 'gap') return { from: event.missingFrom, to: event.missingTo }
	return { from: event.fromSeq, to: subtractOne(event.nextSeq) }
}

function subtractOne(input: string): string {
	try {
		const value = BigInt(input)
		return (value > 0n ? value - 1n : 0n).toString(10)
	} catch {
		return input
	}
}

function compareSequence(left: string, right: string): number {
	try {
		const a = BigInt(left)
		const b = BigInt(right)
		return a < b ? -1 : a > b ? 1 : 0
	} catch {
		return left.localeCompare(right)
	}
}

function readRpcRecord(input: unknown): Record<string, unknown> | undefined {
	return input && typeof input === 'object' && !Array.isArray(input)
		? (input as Record<string, unknown>)
		: undefined
}

const MAX_PLUGIN_CATALOG_SECTIONS = 10_000
const MAX_PLUGIN_CATALOG_NODES = 10_000
// A source-derived ID may contain the percent-encoded form of a maximal canonical source path.
const MAX_PLUGIN_CATALOG_SECTION_ID = 16_384

function parseRpcPluginCatalogLayout(
	input: unknown,
):
	| Readonly<{ ok: true; value: PluginCatalogLayoutInput }>
	| Readonly<{ ok: false; error: string }> {
	const layout = readRpcRecord(input)
	if (!layout || !hasExactKeys(layout, ['sections']) || !Array.isArray(layout.sections)) {
		return { ok: false, error: 'Plugin catalog layout must contain only a sections array' }
	}
	if (layout.sections.length > MAX_PLUGIN_CATALOG_SECTIONS) {
		return {
			ok: false,
			error: `Plugin catalog layout exceeds ${MAX_PLUGIN_CATALOG_SECTIONS} sections`,
		}
	}
	let totalNodes = 0
	const sections: PluginCatalogLayoutInput['sections'][number][] = []
	for (const [index, value] of layout.sections.entries()) {
		const section = readRpcRecord(value)
		if (!section || !hasExactKeys(section, ['sectionId', 'nodes'])) {
			return { ok: false, error: `sections[${index}] must be a closed section object` }
		}
		const sectionId = boundedRpcText(section.sectionId, MAX_PLUGIN_CATALOG_SECTION_ID)
		if (!sectionId || !Array.isArray(section.nodes)) {
			return { ok: false, error: `sections[${index}] has invalid fields` }
		}
		totalNodes += section.nodes.length
		if (totalNodes > MAX_PLUGIN_CATALOG_NODES) {
			return {
				ok: false,
				error: `Plugin catalog layout exceeds ${MAX_PLUGIN_CATALOG_NODES} total nodes`,
			}
		}
		const nodes: PluginNodeAddress[] = []
		for (const [nodeIndex, rawNode] of section.nodes.entries()) {
			const node = parseRpcNode(rawNode)
			if (!node) {
				return {
					ok: false,
					error: `sections[${index}].nodes[${nodeIndex}] is invalid`,
				}
			}
			nodes.push(node)
		}
		sections.push(Object.freeze({ sectionId, nodes: Object.freeze(nodes) }))
	}
	return {
		ok: true,
		value: Object.freeze({ sections: Object.freeze(sections) }),
	}
}

function hasExactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
	const keys = Object.keys(record)
	return keys.length === expected.length && expected.every((key) => Object.hasOwn(record, key))
}

function hasOnlyKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
	return Object.keys(record).every((key) => allowed.includes(key))
}

function boundedRpcText(input: unknown, maxLength: number): string | undefined {
	if (typeof input !== 'string') return undefined
	const value = input.trim()
	return value && value.length <= maxLength ? value : undefined
}

function parseRpcNode(input: unknown): PluginNodeAddress | undefined {
	try {
		return parsePluginNodeAddress(input)
	} catch {
		return undefined
	}
}

function parseRpcDefinition(input: unknown): PluginDefinitionAddress | undefined {
	try {
		return parsePluginDefinitionAddress(input)
	} catch {
		return undefined
	}
}

function parseRpcNullableNode(
	input: unknown,
): Readonly<{ ok: true; value: PluginNodeAddress | null }> | Readonly<{ ok: false }> {
	if (input === null) return { ok: true, value: null }
	const value = parseRpcNode(input)
	return value ? { ok: true, value } : { ok: false }
}

function parseRpcForkSelection(input: unknown):
	| Readonly<{
			ok: true
			value?: Readonly<{
				consumer: PluginNodeAddress
				requirement: PluginDefinitionAddress
			}>
	  }>
	| Readonly<{ ok: false }> {
	if (input === undefined) return { ok: true }
	const record = readRpcRecord(input)
	const consumer = parseRpcNode(record?.consumer)
	const requirement = parseRpcDefinition(record?.requirement)
	if (!record || !hasExactKeys(record, ['consumer', 'requirement']) || !consumer || !requirement) {
		return { ok: false }
	}
	return {
		ok: true,
		value: Object.freeze({ consumer, requirement }),
	}
}

function invalidConfigInput(message: string): ConfigResult {
	return { ok: false, code: 'invalid_input', state: 'unchanged', message }
}

function invalidDependencyInput(message: string): {
	ok: false
	code: 'invalid_input'
	state: 'unchanged'
	error: string
} {
	return { ok: false, code: 'invalid_input', state: 'unchanged', error: message }
}

function unavailableConsumerRequirementsQuery(error: unknown): {
	ok: false
	code: 'consumer_unavailable'
	state: 'unchanged'
	error: string
} {
	if (error instanceof PluginNodeUnavailableError) {
		return {
			ok: false,
			code: 'consumer_unavailable',
			state: 'unchanged',
			error: error.message,
		}
	}
	throw error
}

function unavailableProviderPolicyQuery(error: unknown): {
	ok: false
	code: 'provider_policy_unavailable'
	state: 'unchanged'
	error: string
} {
	if (error instanceof PluginNodeUnavailableError) {
		return {
			ok: false,
			code: 'provider_policy_unavailable',
			state: 'unchanged',
			error: error.message,
		}
	}
	throw error
}
