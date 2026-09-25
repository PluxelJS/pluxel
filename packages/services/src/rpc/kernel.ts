import { randomUUID } from 'node:crypto'
import type {
	CommandContext,
	CommandDescriptor,
	CommandFailure,
	DirectCommand,
} from '@pluxel/commands'
import type { Context } from '@pluxel/core'
import { enterOwnerInvocation } from '@pluxel/core/internal'
import { JsonWireError, copyJson, type JsonValue } from '../internal/json-wire'

type AnyCommand = DirectCommand<any, unknown, any>
type FailureCode = CommandFailure['code']
type Outcome = 'not_started' | 'unknown'
const reservedMethods = new Set([
	...Object.getOwnPropertyNames(Object.prototype),
	'prototype',
	'then',
	'catch',
	'finally',
])

export type RpcContract = Readonly<{ id: string; hash: string }>

/** Internal runtime projection injected only after build-time source and integrity checks. */
export type RpcArtifact = Readonly<{
	format: 'pluxel-rpc-artifact-v1'
	integrity: string
	contract: RpcContract
	methods: readonly Readonly<{
		method: string
		command: string
		description: string
		inputSchema: Readonly<Record<string, unknown>>
	}>[]
	types: readonly Readonly<{ method: string; input: string; success: string }>[]
	declaration: string
}>

export type RpcDescription = Readonly<{
	sessionId: string
	id: string
	hash: string
	generation: number
	methods: RpcArtifact['methods']
	types: RpcArtifact['types']
	declaration: string
}>

export type RpcSearchResult = Readonly<{
	items: readonly Readonly<{
		id: string
		hash: string
		operations: readonly Readonly<{ method: string; description: string }>[]
	}>[]
	hasMore: boolean
}>

export type RpcBuildPublication = Readonly<{
	api: Readonly<{ id: string; commands: Readonly<Record<string, AnyCommand>> }>
	bindings: Readonly<Record<string, AnyCommand>>
	artifact: RpcArtifact
}>

type RpcFailureBase = Readonly<{
	message: string
	callId: string
	outcome: Outcome
}>
export type RpcFailure = RpcFailureBase &
	(
		| Readonly<{ code: 'REJECTED'; reason: string }>
		| Readonly<{
				code: 'INPUT_VALIDATION'
				issues: readonly Readonly<{
					path?: readonly (string | number)[]
					code?: string
					message: string
				}>[]
		  }>
		| Readonly<{ code: Exclude<FailureCode, 'REJECTED' | 'INPUT_VALIDATION'> }>
	)

export type RpcResult =
	| Readonly<{ ok: true; value: JsonValue }>
	| Readonly<{ ok: false; error: RpcFailure }>

export type RpcInvocation = Readonly<{
	principal: unknown
	id: string
	method: string
	name: string
	signal: AbortSignal
}>

export type RpcPublicationOptions = Readonly<{
	authorize?: (invocation: RpcInvocation) => boolean | Promise<boolean>
	context?: (
		invocation: RpcInvocation,
	) => Record<string, unknown> | Promise<Record<string, unknown>>
}>

type Publication = {
	readonly id: string
	readonly contract: RpcContract
	readonly generation: number
	readonly owner: Context
	readonly methods: ReadonlyMap<string, AnyCommand>
	readonly description: Omit<RpcDescription, 'sessionId'>
	readonly options: RpcPublicationOptions
	active: boolean
	guard?: { cancel(): void }
}

export type RpcPublication = Readonly<{
	contract: RpcContract
	generation: number
	dispose(): void
	[Symbol.dispose](): void
}>

export type RpcSessionOptions = Readonly<{
	principal: unknown
	access: readonly RpcContract[]
}>

export type RpcCall = Readonly<{
	id: string
	method: string
	input: unknown
	callId?: string
	signal?: AbortSignal
}>

export type RpcDelivery = Readonly<{ result: RpcResult; release(): void }>

export interface RpcSessionHandle extends AsyncDisposable {
	readonly principal: unknown
	search(options: Readonly<{ query: string; limit?: number }>): Promise<RpcSearchResult>
	describe(options: Readonly<{ apis: readonly string[] }>): Promise<readonly RpcDescription[]>
	revoke(ids: readonly string[]): void
	call(input: RpcCall): Promise<RpcResult>
	close(): Promise<void>
}

/** Internal session capabilities for the HTTP carrier and isolated executor. */
export interface RpcKernelSession extends RpcSessionHandle {
	readonly closedSignal: AbortSignal
	isDescriptionCurrent(description: RpcDescription): boolean
	callForDelivery(input: RpcCall): Promise<RpcDelivery>
	trackBorrowedRun(task: Promise<unknown>): void
}

function configError(message: string): never {
	throw new TypeError(`RPC publication: ${message}`)
}

function checkArtifact(
	publication: RpcBuildPublication,
	expectedBindings: Readonly<Record<string, AnyCommand>>,
): Map<string, AnyCommand> {
	const { artifact, bindings } = publication
	const commands = publication.api?.commands
	if (artifact.format !== 'pluxel-rpc-artifact-v1' || !/^[a-f0-9]{64}$/.test(artifact.integrity)) {
		configError('missing verified build artifact')
	}
	if (
		!/^[A-Za-z0-9_.:-]{1,128}$/.test(artifact.contract?.id ?? '') ||
		!/^[a-f0-9]{64}$/.test(artifact.contract?.hash ?? '') ||
		!Array.isArray(artifact.methods) ||
		!Array.isArray(artifact.types) ||
		typeof artifact.declaration !== 'string' ||
		artifact.declaration.length === 0
	) {
		configError('invalid contract or methods')
	}
	if (publication.api.id !== artifact.contract.id) configError('API id differs from artifact')
	if (!commands || !bindings || typeof commands !== 'object' || typeof bindings !== 'object') {
		configError('missing method bindings')
	}
	const methods = new Map<string, AnyCommand>()
	const names = Object.keys(commands)
	if (
		names.length !== artifact.methods.length ||
		names.length !== artifact.types.length ||
		names.length !== Object.keys(bindings).length ||
		names.length !== Object.keys(expectedBindings).length ||
		names.length === 0
	)
		configError('method table differs from artifact')
	for (const entry of artifact.methods) {
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(entry.method) || reservedMethods.has(entry.method)) {
			configError('invalid method name')
		}
		if (methods.has(entry.method) || !Object.hasOwn(commands, entry.method)) {
			configError('method table differs from artifact')
		}
		const command = commands[entry.method]
		const descriptor: CommandDescriptor | undefined = command?.descriptor
		if (
			!command ||
			bindings?.[entry.method] !== command ||
			expectedBindings[entry.method] !== command ||
			command.name !== entry.command ||
			descriptor?.name !== entry.command ||
			descriptor.description !== entry.description ||
			JSON.stringify(descriptor.inputSchema) !== JSON.stringify(entry.inputSchema)
		) {
			configError(`stale Command binding for ${entry.method}`)
		}
		const execute = command.execute
		methods.set(
			entry.method,
			Object.freeze({
				name: command.name,
				descriptor: Object.freeze({ ...descriptor }),
				execute: (candidate: unknown, context: CommandContext) =>
					Reflect.apply(execute, command, [candidate, context]),
			}) as AnyCommand,
		)
	}
	const typedMethods = new Set<string>()
	for (const entry of artifact.types) {
		if (
			!methods.has(entry.method) ||
			typedMethods.has(entry.method) ||
			typeof entry.input !== 'string' ||
			typeof entry.success !== 'string' ||
			entry.input.length === 0 ||
			entry.success.length === 0
		)
			configError('type declaration differs from method table')
		typedMethods.add(entry.method)
	}
	return methods
}

function freezeJson<T>(value: T): T {
	if (value && typeof value === 'object') {
		for (const child of Object.values(value)) freezeJson(child)
		Object.freeze(value)
	}
	return value
}

function publicFailure(failure: CommandFailure, callId: string, outcome: Outcome): RpcFailure {
	const base = { message: failure.message, callId, outcome }
	if (failure.code === 'REJECTED') return { ...base, code: failure.code, reason: failure.reason }
	if (failure.code === 'INPUT_VALIDATION') {
		return {
			...base,
			code: failure.code,
			issues: failure.issues.map((issue) => ({
				...(issue.path ? { path: issue.path } : {}),
				...(issue.code ? { code: issue.code } : {}),
				message: issue.message,
			})),
		}
	}
	return { ...base, code: failure.code }
}

function error(
	code: Exclude<FailureCode, 'REJECTED' | 'INPUT_VALIDATION'>,
	message: string,
	callId: string,
	outcome: Outcome,
): RpcResult {
	return { ok: false, error: { code, message, callId, outcome } }
}

function visibleDeclaration(
	description: Omit<RpcDescription, 'sessionId'>,
	visible: ReadonlySet<string>,
): string {
	if (visible.size === description.types.length) return description.declaration
	const start = description.declaration.indexOf('export interface RpcApi {\n')
	const end = description.declaration.indexOf('}\nexport interface RpcClient ', start)
	if (start < 0 || end < 0) throw new TypeError('RPC client declaration cannot be filtered')
	const methods = description.types
		.filter(({ method }) => visible.has(method))
		.map(
			({ method, input, success }) =>
				`  ${JSON.stringify(method)}(input: ${input}): Promise<RpcResult<${success}>>;`,
		)
		.join('\n')
	return `${description.declaration.slice(0, start)}export interface RpcApi {\n${methods}\n${description.declaration.slice(end)}`
}

function isBusinessContext(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false
	const prototype = Object.getPrototypeOf(value)
	if (prototype !== Object.prototype && prototype !== null) return false
	if (Object.getOwnPropertySymbols(value).length > 0) return false
	const descriptors = Object.getOwnPropertyDescriptors(value)
	return Object.entries(descriptors).every(
		([key, descriptor]) =>
			key !== 'signal' &&
			key !== 'deadlineMs' &&
			key !== 'meta' &&
			descriptor.enumerable &&
			'value' in descriptor,
	)
}

function snapshotBusinessContext(value: unknown): Record<string, unknown> {
	if (!isBusinessContext(value)) throw new TypeError('RPC context factory returned invalid context')
	const seen = new WeakSet<object>()
	let nodes = 0
	const copy = (input: unknown, depth: number): unknown => {
		if (++nodes > 10_000 || depth > 32) throw new TypeError('RPC context exceeds snapshot limit')
		if (!input || typeof input !== 'object') return input
		const prototype = Object.getPrototypeOf(input)
		if (prototype !== Object.prototype && prototype !== null && !Array.isArray(input)) return input
		if (seen.has(input)) throw new TypeError('RPC context contains a cycle')
		seen.add(input)
		if (Object.getOwnPropertySymbols(input).length > 0)
			throw new TypeError('RPC context has symbol keys')
		const snapshot: Record<string, unknown> | unknown[] = Array.isArray(input)
			? []
			: Object.create(null)
		for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(input))) {
			if (Array.isArray(input) && key === 'length') continue
			if (!descriptor.enumerable || !('value' in descriptor)) {
				throw new TypeError('RPC context has an accessor or hidden value')
			}
			if (Array.isArray(input)) {
				if (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= input.length) {
					throw new TypeError('RPC context array has extra properties')
				}
				;(snapshot as unknown[])[Number(key)] = copy(descriptor.value, depth + 1)
			} else {
				;(snapshot as Record<string, unknown>)[key] = copy(descriptor.value, depth + 1)
			}
		}
		if (Array.isArray(input)) {
			for (let index = 0; index < input.length; index++) {
				if (!Object.hasOwn(snapshot, index)) throw new TypeError('RPC context array has holes')
			}
		}
		seen.delete(input)
		return Object.freeze(snapshot)
	}
	return copy(value, 0) as Record<string, unknown>
}

/** Server-side kernel; no package export or transport is installed by this module. */
export class RpcKernel {
	readonly #publications = new Map<string, Publication>()
	readonly #generations = new Map<string, number>()
	readonly #sessions = new Set<RpcSession>()
	#open = true
	readonly #maxOutputBytes: number
	readonly #maxInputBytes: number
	readonly #maxDescriptionBytes: number
	readonly #verifyArtifact: (
		artifact: RpcArtifact,
	) => Readonly<Record<string, AnyCommand>> | undefined

	constructor(
		readonly providerOwner: Context,
		options: Readonly<{
			/** Installed by the trusted build loader; must verify the full artifact integrity/provenance. */
			verifyArtifact: (artifact: RpcArtifact) => Readonly<Record<string, AnyCommand>> | undefined
			maxOutputBytes?: number
			maxInputBytes?: number
			maxDescriptionBytes?: number
		}>,
	) {
		if (typeof options.verifyArtifact !== 'function')
			throw new TypeError('RPC requires an artifact verifier')
		this.#verifyArtifact = options.verifyArtifact
		this.#maxOutputBytes = options.maxOutputBytes ?? 1_048_576
		this.#maxInputBytes = options.maxInputBytes ?? 1_048_576
		this.#maxDescriptionBytes = options.maxDescriptionBytes ?? 262_144
		if (!Number.isSafeInteger(this.#maxOutputBytes) || this.#maxOutputBytes < 1) {
			throw new TypeError('RPC maxOutputBytes must be a positive integer')
		}
		if (!Number.isSafeInteger(this.#maxInputBytes) || this.#maxInputBytes < 1) {
			throw new TypeError('RPC maxInputBytes must be a positive integer')
		}
		if (!Number.isSafeInteger(this.#maxDescriptionBytes) || this.#maxDescriptionBytes < 1) {
			throw new TypeError('RPC maxDescriptionBytes must be a positive integer')
		}
		providerOwner.effects.defer(() => this.withdrawAll(), { tag: 'RpcKernel' })
	}

	publish(
		owner: Context,
		publication: RpcBuildPublication,
		options: RpcPublicationOptions = {},
	): RpcPublication {
		if (!this.#open) configError('provider stopped')
		if (owner.root !== this.providerOwner.root) configError('owner belongs to another Runtime')
		const expectedBindings = this.#verifyArtifact(publication.artifact)
		if (!expectedBindings) configError('untrusted build artifact')
		const methods = checkArtifact(publication, expectedBindings)
		const artifact = publication.artifact
		const id = artifact.contract.id
		if (this.#publications.has(id)) configError(`duplicate API id ${id}`)
		const generation = (this.#generations.get(id) ?? 0) + 1
		let description: Omit<RpcDescription, 'sessionId'>
		try {
			description = freezeJson(
				copyJson(
					{
						id,
						hash: artifact.contract.hash,
						generation,
						methods: artifact.methods,
						types: artifact.types,
						declaration: artifact.declaration,
					},
					this.#maxDescriptionBytes,
				).value,
			) as unknown as Omit<RpcDescription, 'sessionId'>
		} catch (cause) {
			throw new TypeError('RPC description is invalid or exceeds its budget', { cause })
		}
		const record: Publication = {
			id,
			contract: Object.freeze({ ...artifact.contract }),
			generation,
			owner,
			methods,
			description,
			options: Object.freeze({ authorize: options.authorize, context: options.context }),
			active: false,
		}
		let providerLease
		try {
			providerLease = enterOwnerInvocation(this.providerOwner)
			const ownerLease =
				owner === this.providerOwner ? undefined : enterOwnerInvocation(owner, providerLease.signal)
			ownerLease?.dispose()
			record.guard = owner.effects.defer(() => this.withdraw(record, false), {
				tag: `RpcPublication:${id}`,
			})
			this.#publications.set(id, record)
			this.#generations.set(id, generation)
			record.active = true
		} catch (failure) {
			this.report('RPC publication installation failed', failure)
			record.guard?.cancel()
			throw failure
		} finally {
			providerLease?.dispose()
		}
		return Object.freeze({
			contract: record.contract,
			generation,
			dispose: () => this.withdraw(record, true),
			[Symbol.dispose]: () => this.withdraw(record, true),
		})
	}

	createSession(options: RpcSessionOptions): RpcKernelSession {
		if (!this.#open) throw new Error('RPC provider stopped')
		const access = new Map<string, Publication>()
		for (const contract of options.access) {
			const record = this.#publications.get(contract.id)
			if (!record?.active || record.contract.hash !== contract.hash || access.has(contract.id)) {
				throw new TypeError('RPC access does not match current publication')
			}
			access.set(contract.id, record)
		}
		if (options.principal === null || options.principal === undefined) {
			throw new TypeError('RPC principal must be an authenticated value')
		}
		const session = new RpcSession(SESSION_TOKEN, this, options.principal, access)
		this.#sessions.add(session)
		return session
	}

	isCurrent(record: Publication): boolean {
		return this.#publications.get(record.id) === record
	}

	copyInput(value: unknown): JsonValue {
		return copyJson(value, this.#maxInputBytes).value
	}

	copyDescription<T>(value: T): T {
		return freezeJson(copyJson(value, this.#maxDescriptionBytes).value) as T
	}

	project(value: unknown, callId: string): RpcResult {
		try {
			return copyJson({ ok: true, value: value === undefined ? null : value }, this.#maxOutputBytes)
				.value as unknown as RpcResult
		} catch (failure) {
			this.report('RPC success output could not be delivered', failure)
			return error(
				failure instanceof JsonWireError ? failure.code : 'INTERNAL',
				'RPC output cannot be delivered',
				callId,
				'unknown',
			)
		}
	}

	projectError(failure: CommandFailure, callId: string): RpcResult {
		try {
			return copyJson(
				{ ok: false, error: publicFailure(failure, callId, 'unknown') },
				this.#maxOutputBytes,
			).value as unknown as RpcResult
		} catch (projectionError) {
			this.report('RPC failure output could not be delivered', projectionError)
			return error(
				projectionError instanceof JsonWireError ? projectionError.code : 'INTERNAL',
				'RPC failure cannot be delivered',
				callId,
				'unknown',
			)
		}
	}

	report(message: string, cause: unknown): void {
		try {
			this.providerOwner.logger.error(message, { error: cause })
		} catch {
			// Diagnostics cannot change a wire result.
		}
	}

	forget(session: RpcSession): void {
		this.#sessions.delete(session)
	}

	private withdraw(record: Publication, cancelGuard: boolean): void {
		if (!record.active) return
		record.active = false
		if (this.#publications.get(record.id) === record) this.#publications.delete(record.id)
		if (cancelGuard) record.guard?.cancel()
	}

	private async withdrawAll(): Promise<void> {
		this.#open = false
		for (const record of this.#publications.values()) this.withdraw(record, false)
		await Promise.all([...this.#sessions].map((session) => session.close()))
	}
}

const SESSION_TOKEN = Symbol('RpcSession constructor')

class RpcSessionClosedError extends Error {
	constructor() {
		super('RPC session closed')
	}
}

class RpcSession implements RpcKernelSession {
	readonly principal!: unknown
	readonly #sessionId = randomUUID()
	readonly #described = new WeakSet<object>()
	readonly #revoked = new Set<string>()
	readonly #access: ReadonlyMap<string, Publication>
	readonly #kernel: RpcKernel
	readonly #abort = new AbortController()
	readonly #pending = new Set<Promise<unknown>>()
	readonly #deliveries = new Set<Promise<void>>()
	#closing?: Promise<void>
	#open = true

	constructor(
		token: typeof SESSION_TOKEN,
		kernel: RpcKernel,
		principal: unknown,
		access: ReadonlyMap<string, Publication>,
	) {
		if (token !== SESSION_TOKEN) throw new TypeError('RPC session must be created by its kernel')
		Object.defineProperty(this, 'principal', {
			value: principal,
			enumerable: true,
			configurable: false,
			writable: false,
		})
		this.#kernel = kernel
		this.#access = access
	}

	get closedSignal(): AbortSignal {
		return this.#abort.signal
	}

	search(options: Readonly<{ query: string; limit?: number }>): Promise<RpcSearchResult> {
		if (!this.#open) return Promise.reject(new RpcSessionClosedError())
		return this.track(this.searchNow(options))
	}

	private async searchNow(
		options: Readonly<{ query: string; limit?: number }>,
	): Promise<RpcSearchResult> {
		if (!this.#open) throw new RpcSessionClosedError()
		if (typeof options?.query !== 'string' || options.query.length > 1_024) {
			throw new TypeError('RPC search query must be a string of at most 1024 characters')
		}
		const limit = options.limit ?? 10
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
			throw new RangeError('RPC search limit must be between 1 and 50')
		}
		const query = options.query.trim().toLowerCase()
		const matches: {
			record: Publication
			item: RpcSearchResult['items'][number]
		}[] = []
		for (const record of [...this.#access.values()].sort((a, b) =>
			a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
		)) {
			const visible = await this.visibleMethods(record)
			if (visible.size === 0) continue
			const methods = record.description.methods.filter(({ method }) => visible.has(method))
			const operations = methods.map(({ method, description }) => ({
				method,
				description,
			}))
			if (
				query &&
				!record.id.toLowerCase().includes(query) &&
				!methods.some(
					({ method, command, description }) =>
						method.toLowerCase().includes(query) ||
						command.toLowerCase().includes(query) ||
						description.toLowerCase().includes(query),
				)
			)
				continue
			matches.push({
				record,
				item: { id: record.id, hash: record.contract.hash, operations },
			})
		}
		if (!this.#open) throw new RpcSessionClosedError()
		const current = matches.filter(({ record }) => this.isAvailable(record)).map(({ item }) => item)
		try {
			return this.#kernel.copyDescription({
				items: current.slice(0, limit),
				hasMore: current.length > limit,
			})
		} catch (cause) {
			throw new RangeError('RPC search exceeds description budget', { cause })
		}
	}

	describe(options: Readonly<{ apis: readonly string[] }>): Promise<readonly RpcDescription[]> {
		if (!this.#open) return Promise.reject(new RpcSessionClosedError())
		return this.track(this.describeNow(options))
	}

	private async describeNow(
		options: Readonly<{ apis: readonly string[] }>,
	): Promise<readonly RpcDescription[]> {
		if (!this.#open) throw new RpcSessionClosedError()
		if (!Array.isArray(options?.apis) || options.apis.length > 50) {
			throw new RangeError('RPC describe accepts at most 50 API IDs')
		}
		const selected = new Set<string>()
		const records: Array<{ record: Publication; visible: ReadonlySet<string> }> = []
		for (const id of options.apis) {
			if (typeof id !== 'string' || selected.has(id))
				throw new TypeError('RPC API selection is invalid')
			selected.add(id)
			const record = this.#access.get(id)
			const visible = record ? await this.visibleMethods(record) : new Set<string>()
			if (!record || visible.size === 0) {
				if (!this.#open) throw new RpcSessionClosedError()
				throw new TypeError('RPC API unavailable')
			}
			records.push({ record, visible })
		}
		if (records.some(({ record }) => !this.isAvailable(record)))
			throw new TypeError('RPC API unavailable')
		const projected = records.map(({ record, visible }) => ({
			sessionId: this.#sessionId,
			id: record.description.id,
			hash: record.description.hash,
			generation: record.description.generation,
			methods: record.description.methods.filter(({ method }) => visible.has(method)),
			types: record.description.types.filter(({ method }) => visible.has(method)),
			declaration: visibleDeclaration(record.description, visible),
		}))
		let descriptions: readonly RpcDescription[]
		try {
			descriptions = this.#kernel.copyDescription(projected)
		} catch (cause) {
			throw new RangeError('RPC descriptions exceed budget', { cause })
		}
		for (const description of descriptions) this.#described.add(description)
		return descriptions
	}

	isDescriptionCurrent(description: RpcDescription): boolean {
		if (!description || typeof description !== 'object' || !this.#described.has(description))
			return false
		const record = this.#access.get(description.id)
		return (
			!!record &&
			this.isAvailable(record) &&
			description.sessionId === this.#sessionId &&
			description.hash === record.contract.hash &&
			description.generation === record.generation
		)
	}

	private isAvailable(record: Publication): boolean {
		return (
			this.#open && !this.#revoked.has(record.id) && record.active && this.#kernel.isCurrent(record)
		)
	}

	private async visibleMethods(record: Publication): Promise<ReadonlySet<string>> {
		const visible = new Set<string>()
		if (!this.isAvailable(record)) return visible
		let providerLease
		let ownerLease: ReturnType<typeof enterOwnerInvocation> | undefined
		try {
			providerLease = enterOwnerInvocation(this.#kernel.providerOwner, this.#abort.signal)
			if (record.owner !== this.#kernel.providerOwner) {
				ownerLease = enterOwnerInvocation(record.owner, providerLease.signal)
			}
			const signal = ownerLease?.signal ?? providerLease.signal
			for (const [method, command] of record.methods) {
				const invocation = Object.freeze({
					principal: this.principal,
					id: record.id,
					method,
					name: command.name,
					signal,
				})
				if (!record.options.authorize || (await record.options.authorize(invocation)))
					visible.add(method)
				if (!this.isAvailable(record) || signal.aborted) return new Set<string>()
			}
			return visible
		} catch (cause) {
			if (!this.#open) throw new RpcSessionClosedError()
			this.#kernel.report('RPC discovery authorization failed', cause)
			throw new Error('RPC discovery authorization failed', { cause })
		} finally {
			ownerLease?.dispose()
			providerLease?.dispose()
		}
	}

	revoke(ids: readonly string[]): void {
		for (const id of ids) this.#revoked.add(id)
	}

	async call(input: RpcCall): Promise<RpcResult> {
		const delivery = await this.callForDelivery(input)
		try {
			return delivery.result
		} finally {
			delivery.release()
		}
	}

	callForDelivery(input: RpcCall): Promise<RpcDelivery> {
		const callId = input.callId ?? randomUUID()
		if (typeof callId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(callId)) {
			return Promise.resolve({
				result: {
					ok: false,
					error: {
						code: 'INPUT_VALIDATION',
						message: 'Invalid RPC call ID',
						callId: randomUUID(),
						outcome: 'not_started',
						issues: [{ message: 'Invalid callId' }],
					},
				},
				release() {},
			})
		}
		if (!this.#open)
			return Promise.resolve({
				result: error('ABORTED', 'RPC session closed', callId, 'not_started'),
				release() {},
			})
		return this.track(this.invoke(input, callId))
	}

	private track<T>(task: Promise<T>): Promise<T> {
		this.#pending.add(task)
		void task.then(
			() => this.#pending.delete(task),
			() => this.#pending.delete(task),
		)
		return task
	}

	trackBorrowedRun(task: Promise<unknown>): void {
		if (!this.#open) throw new RpcSessionClosedError()
		void this.track(task)
	}

	private async invoke(input: RpcCall, callId: string): Promise<RpcDelivery> {
		const withoutLease = (result: RpcResult): RpcDelivery => ({ result, release() {} })
		const record = this.#access.get(input.id)
		if (!record || this.#revoked.has(input.id))
			return withoutLease(error('FORBIDDEN', 'RPC access denied', callId, 'not_started'))
		if (!record.active || !this.#kernel.isCurrent(record)) {
			return withoutLease(
				error('PUBLICATION_GONE', 'RPC publication unavailable', callId, 'not_started'),
			)
		}
		const command = record.methods.get(input.method)
		if (!command)
			return withoutLease(error('COMMAND_NOT_FOUND', 'RPC method not found', callId, 'not_started'))
		let wireInput: JsonValue
		try {
			wireInput = this.#kernel.copyInput(input.input)
		} catch (cause) {
			if (!(cause instanceof JsonWireError))
				this.#kernel.report('RPC input validation failed', cause)
			return withoutLease({
				ok: false,
				error: {
					code: 'INPUT_VALIDATION',
					message: 'RPC input must be bounded JSON',
					callId,
					outcome: 'not_started',
					issues: [{ message: 'RPC input must be bounded JSON' }],
				},
			})
		}
		let providerLease
		let ownerLease: ReturnType<typeof enterOwnerInvocation> | undefined
		try {
			const signal = input.signal
				? AbortSignal.any([input.signal, this.#abort.signal])
				: this.#abort.signal
			providerLease = enterOwnerInvocation(this.#kernel.providerOwner, signal)
			if (record.owner !== this.#kernel.providerOwner) {
				ownerLease = enterOwnerInvocation(record.owner, providerLease.signal)
			}
		} catch {
			ownerLease?.dispose()
			providerLease?.dispose()
			return withoutLease(error('ABORTED', 'RPC owner unavailable', callId, 'not_started'))
		}
		let resolveDelivery!: () => void
		const delivered = new Promise<void>((resolve) => {
			resolveDelivery = resolve
		})
		this.#deliveries.add(delivered)
		let released = false
		const release = () => {
			if (released) return
			released = true
			try {
				try {
					ownerLease?.dispose()
				} finally {
					providerLease.dispose()
				}
			} finally {
				this.#deliveries.delete(delivered)
				resolveDelivery()
			}
		}
		let handedOff = false
		const deliver = (result: RpcResult): RpcDelivery => {
			handedOff = true
			return { result, release }
		}
		const signal = ownerLease?.signal ?? providerLease.signal
		let started = false
		try {
			const invocation = Object.freeze({
				principal: this.principal,
				id: input.id,
				method: input.method,
				name: command.name,
				signal,
			})
			const business = snapshotBusinessContext(
				record.options.context ? await record.options.context(invocation) : {},
			)
			if (record.options.authorize && !(await record.options.authorize(invocation))) {
				return deliver(error('FORBIDDEN', 'RPC access denied', callId, 'not_started'))
			}
			// No await may separate the final admission check from Command.execute.
			if (!this.#open || signal.aborted)
				return deliver(error('ABORTED', 'RPC call aborted', callId, 'not_started'))
			if (this.#revoked.has(input.id))
				return deliver(error('FORBIDDEN', 'RPC access denied', callId, 'not_started'))
			if (!record.active || !this.#kernel.isCurrent(record)) {
				return deliver(
					error('PUBLICATION_GONE', 'RPC publication unavailable', callId, 'not_started'),
				)
			}
			started = true
			const result = await command.execute(wireInput, { ...business, signal } as CommandContext)
			return deliver(
				result.isErr()
					? this.#kernel.projectError(result.error, callId)
					: this.#kernel.project(result.value, callId),
			)
		} catch (cause) {
			this.#kernel.report('RPC method invocation failed', cause)
			return deliver(
				error('INTERNAL', 'RPC method failed', callId, started ? 'unknown' : 'not_started'),
			)
		} finally {
			if (!handedOff) release()
		}
	}

	close(): Promise<void> {
		if (this.#closing) return this.#closing
		this.#open = false
		this.#abort.abort()
		this.#closing = Promise.allSettled(this.#pending).then(async (outcomes): Promise<void> => {
			await Promise.all(this.#deliveries)
			this.#kernel.forget(this)
			const failures = outcomes.flatMap((outcome) =>
				outcome.status === 'rejected' && !(outcome.reason instanceof RpcSessionClosedError)
					? [outcome.reason]
					: [],
			)
			if (failures.length > 0) throw new AggregateError(failures, 'RPC session cleanup failed')
			return undefined
		})
		return this.#closing
	}

	[Symbol.asyncDispose](): Promise<void> {
		return this.close()
	}
}
