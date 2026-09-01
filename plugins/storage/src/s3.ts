import { resolve } from 'node:path'
import { f, Plugin, type Context, v } from '@pluxel/runtime'
import type { VaultKvHandle } from '@pluxel/runtime/services/vault'
import type { WorkbenchContentActionResult, WorkbenchPrincipal } from '@pluxel/runtime/workbench'
import { S3mini } from 's3mini'
import {
	S3,
	type S3Bucket,
	S3BucketNotFoundError,
	type S3Client,
	S3NotRunningError,
} from './capability.ts'
import { LocalS3Client } from './local.ts'
import { isS3BucketId } from './validation.ts'
import {
	S3Workbench,
	type S3CredentialRotationInput,
	type S3OperationsStatus,
} from './workbench.ts'

const MEBIBYTE = 1024 * 1024
const MAX_BUCKETS = 64

function isCredentialFreeS3Endpoint(value: string): boolean {
	const url = new URL(value)
	return (
		(url.protocol === 'http:' || url.protocol === 'https:') &&
		!url.username &&
		!url.password &&
		!url.search &&
		!url.hash
	)
}

function isWellFormed(value: string): boolean {
	const candidate = value as string & { isWellFormed?: () => boolean }
	return typeof candidate.isWellFormed === 'function'
		? candidate.isWellFormed()
		: !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value)
}

const S3BucketId = v.pipe(
	v.string(),
	v.check(
		isS3BucketId,
		'Bucket ID must start with a lowercase letter and contain at most 64 lowercase letters, digits, dots, underscores, or hyphens',
	),
)

const S3Endpoint = v.pipe(
	v.string(),
	v.url(),
	v.check(
		isCredentialFreeS3Endpoint,
		'S3 endpoint must use http:// or https:// without credentials, query, or hash',
	),
)

const LocalRootDir = v.pipe(
	v.string(),
	v.minLength(1),
	v.check((value) => !value.includes('\0'), 'rootDir must not contain NUL'),
)

const LocalBucketName = v.pipe(
	v.string(),
	v.minLength(1),
	v.maxLength(255),
	v.check(isWellFormed, 'bucketName must be well-formed Unicode'),
)

const VaultReference = v.pipe(
	v.string(),
	v.minLength(1),
	v.maxLength(256),
	v.check((value) => !value.includes('\0'), 'Vault reference must not contain NUL'),
)

const LocalBackendConfig = v.object({
	type: v.literal('local'),
	rootDir: v.pipe(
		v.optional(LocalRootDir, '.pluxel/s3'),
		f.formMeta({
			title: 'Local S3 root',
			description: 'Root for locally emulated buckets. Production should place it outside dist/.',
		}),
	),
	bucketName: v.pipe(
		v.optional(LocalBucketName),
		f.formMeta({ title: 'Physical bucket name', description: 'Defaults to the stable bucket ID.' }),
	),
	syncWrites: v.pipe(
		v.optional(v.boolean(), true),
		f.formMeta({
			title: 'Flush writes',
			description: 'fsync completed object files and directory entries where supported.',
		}),
	),
})

const RemoteCredentialsConfig = v.variant('type', [
	v.object({ type: v.literal('anonymous') }),
	v.object({
		type: v.literal('vault'),
		key: v.pipe(
			v.optional(VaultReference),
			f.formMeta({
				title: 'Vault key',
				description: 'Defaults to s3.credentials for default, or s3.<bucket-id>.credentials.',
			}),
		),
		namespace: v.pipe(
			v.optional(VaultReference),
			f.formMeta({
				title: 'Vault namespace',
				description: 'When omitted, use this S3Plugin namespace.',
			}),
		),
	}),
])

const RemoteBackendConfig = v.object({
	type: v.literal('remote'),
	endpoint: v.pipe(
		S3Endpoint,
		f.formMeta({
			title: 'S3 endpoint',
			description:
				'Bucket endpoint in path-style or virtual-hosted-style form. Credentials are separate.',
		}),
	),
	region: v.pipe(
		v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(128)), 'auto'),
		f.formMeta({ title: 'S3 region' }),
	),
	credentials: RemoteCredentialsConfig,
	requestSizeInBytes: v.pipe(
		v.optional(v.pipe(v.number(), v.integer(), v.minValue(1)), 8 * MEBIBYTE),
		f.formMeta({
			title: 'Read request size',
			description: 'Default byte range used by s3mini for ranged reads.',
		}),
	),
	requestAbortTimeout: v.pipe(
		v.optional(v.pipe(v.number(), v.integer(), v.minValue(1)), 30_000),
		f.formMeta({
			title: 'Request timeout',
			description: 'Timeout for each underlying S3 request.',
		}),
	),
	minPartSize: v.pipe(
		v.optional(
			v.pipe(v.number(), v.integer(), v.minValue(5 * MEBIBYTE), v.maxValue(5 * 1024 * MEBIBYTE)),
			8 * MEBIBYTE,
		),
		f.formMeta({
			title: 'Multipart part size',
			description: 'Minimum part size used by s3mini multipart uploads.',
		}),
	),
})

const S3BucketConfig = v.object({
	id: v.pipe(S3BucketId, f.formMeta({ title: 'Bucket ID' })),
	backend: v.variant('type', [LocalBackendConfig, RemoteBackendConfig]),
})

const S3Buckets = v.pipe(
	v.array(S3BucketConfig),
	v.minLength(1, 'At least one S3 bucket is required'),
	v.maxLength(MAX_BUCKETS, `At most ${MAX_BUCKETS} S3 buckets are allowed`),
	v.check(
		(buckets) => new Set(buckets.map((bucket) => bucket.id)).size === buckets.length,
		'S3 bucket IDs must be unique',
	),
)

export const S3Config = v.object({
	buckets: v.pipe(
		v.optional(S3Buckets, [
			{
				id: 'default',
				backend: {
					type: 'local',
					rootDir: '.pluxel/s3',
					bucketName: 'local',
					syncWrites: true,
				},
			},
		]),
		f.formMeta({ title: 'Buckets', description: 'Bounded named S3 bucket catalog.' }),
		f.arrayMeta({ layout: 'list', addLabel: 'Add bucket', itemLabel: 'Bucket' }),
	),
})

export type S3PluginConfig = v.InferOutput<typeof S3Config>
export type S3BucketConfig = S3PluginConfig['buckets'][number]
export type S3AccessKeyCredentials = Readonly<{
	accessKeyId: string
	secretAccessKey: string
}>

export class S3CredentialsError extends Error {
	override name = 'S3CredentialsError'
	readonly code = 'S3_CREDENTIALS_ERROR'

	constructor(
		readonly reason: 'missing' | 'invalid' | 'unavailable',
		readonly bucketId: string,
		readonly key: string,
		cause?: unknown,
	) {
		super(`S3 credentials for bucket "${bucketId}" at Vault key "${key}" are ${reason}.`, {
			cause,
		})
	}
}

type RemoteBackend = Extract<S3BucketConfig['backend'], { type: 'remote' }>
type LocalBackend = Extract<S3BucketConfig['backend'], { type: 'local' }>
type RemoteCredentials = RemoteBackend['credentials']

type S3BucketState = {
	readonly config: S3BucketConfig
	readonly client: S3Client
}

type S3OwnerState = {
	active: boolean
	readonly context: Context
	readonly handles: Map<string, S3Bucket>
}

/** Official bounded S3 bucket catalog with local and remote backends. */
@Plugin(S3)
export class S3Plugin extends S3 {
	private readonly config = this.configs.use(S3Config)
	private ids: readonly string[] = Object.freeze([])
	private readonly states = new Map<string, S3BucketState>()
	private readonly owners = new WeakMap<Context, S3OwnerState>()
	private readonly activeOwners = new Set<S3OwnerState>()
	private credentialReplacementSaved?: Set<string>
	private credentialMutation?: Promise<void>
	private active = false
	private workbenchDataListeners?: Set<() => void>

	override bucket(bucketId = 'default'): S3Bucket {
		this.assertRunning()
		const id = normalizeBucketId(bucketId)
		const state = this.states.get(id)
		if (!state) throw new S3BucketNotFoundError(id)

		const owner = this.owner()
		const existing = owner.handles.get(id)
		if (existing) return existing
		const handle = new S3BucketHandle(id, () => {
			this.assertActive(owner, state)
			return state.client
		})
		owner.handles.set(id, handle)
		return handle
	}

	override bucketIds(): readonly string[] {
		this.assertRunning()
		return this.ids
	}

	protected override async init(signal: AbortSignal): Promise<void> {
		this.ids = Object.freeze(this.config.buckets.map((bucket) => bucket.id))
		const startup = new AbortController()
		const startupSignal = AbortSignal.any([signal, startup.signal])
		const results = await Promise.allSettled(
			this.config.buckets.map(async (bucket) => {
				try {
					await this.startBucket(bucket, startupSignal)
				} catch (error) {
					startup.abort(error)
					throw error
				}
			}),
		)
		const failed = results.find(
			(result): result is PromiseRejectedResult => result.status === 'rejected',
		)
		if (failed) throw failed.reason
		signal.throwIfAborted()

		this.active = true
		try {
			this.ctx.effects.defer(() => this.deactivate(), {
				tag: 'S3BucketCatalog',
				phase: 'shutdown',
			})
		} catch (error) {
			this.deactivate()
			throw error
		}
		this.publishWorkbench()
	}

	private async startBucket(config: S3BucketConfig, signal: AbortSignal): Promise<void> {
		if (config.backend.type === 'local') {
			await this.startLocal(config, config.backend, signal)
			return
		}
		await this.startRemote(config, config.backend, signal)
	}

	private async startLocal(
		config: S3BucketConfig,
		backend: LocalBackend,
		signal: AbortSignal,
	): Promise<void> {
		signal.throwIfAborted()
		const client = new LocalS3Client({
			rootDir: resolve(process.cwd(), backend.rootDir),
			bucketName: backend.bucketName ?? config.id,
			syncWrites: backend.syncWrites,
		})
		await client.createBucket()
		if (signal.aborted) {
			await client.dispose()
			signal.throwIfAborted()
		}
		await this.activate(config, client, () => client.dispose(), `LocalS3Client:${config.id}`)
	}

	private async startRemote(
		config: S3BucketConfig,
		backend: RemoteBackend,
		signal: AbortSignal,
	): Promise<void> {
		const credentials = await this.resolveCredentials(config.id, backend.credentials)
		signal.throwIfAborted()
		const lifecycle = new AbortController()
		const abort = (): void => lifecycle.abort(new S3NotRunningError())
		signal.addEventListener('abort', abort, { once: true })
		const client = new S3mini({
			accessKeyId: credentials?.accessKeyId ?? '',
			secretAccessKey: credentials?.secretAccessKey ?? '',
			endpoint: backend.endpoint,
			region: backend.region,
			requestSizeInBytes: backend.requestSizeInBytes,
			requestAbortTimeout: backend.requestAbortTimeout,
			minPartSize: backend.minPartSize,
			fetch: lifecycleFetch(lifecycle.signal),
		})
		await this.activate(
			config,
			client,
			() => {
				signal.removeEventListener('abort', abort)
				lifecycle.abort(new S3NotRunningError())
			},
			`S3miniClient:${config.id}`,
		)
	}

	private async resolveCredentials(
		bucketId: string,
		config: RemoteCredentials,
	): Promise<S3AccessKeyCredentials | undefined> {
		if (config.type === 'anonymous') return undefined
		const key = credentialKey(bucketId, config)
		let value: unknown
		try {
			const vault = this.ctx.vault
			if (!vault) throw new Error('S3 Vault credentials require host config vault: {}')
			const credentials: VaultKvHandle = vault.kv(
				config.namespace ? { namespace: config.namespace } : undefined,
			)
			value = await credentials.get(key)
		} catch (error) {
			throw new S3CredentialsError('unavailable', bucketId, key, error)
		}
		if (value === undefined) throw new S3CredentialsError('missing', bucketId, key)
		try {
			return normalizeCredentials(value)
		} catch (error) {
			throw new S3CredentialsError('invalid', bucketId, key, error)
		}
	}

	private async activate(
		config: S3BucketConfig,
		client: S3Client,
		disposeClient: () => void | Promise<void>,
		tag: string,
	): Promise<void> {
		const state: S3BucketState = { config, client }
		let disposed = false
		const dispose = async (): Promise<void> => {
			if (disposed) return
			disposed = true
			if (this.states.get(config.id) === state) this.states.delete(config.id)
			await disposeClient()
		}
		try {
			this.ctx.effects.defer(dispose, { tag })
			this.states.set(config.id, state)
		} catch (error) {
			await dispose()
			throw error
		}
	}

	private publishWorkbench(): void {
		const workbench = this.ctx.workbench
		if (!workbench) return
		this.workbenchDataListeners = new Set()
		this.credentialReplacementSaved = new Set()
		this.credentialMutation = Promise.resolve()
		workbench.publish(S3Workbench, {
			buckets: ({ principal, signal, dataChanged }) => {
				const release = (): void => {
					this.workbenchDataListeners?.delete(dataChanged)
				}
				this.workbenchDataListeners.add(dataChanged)
				signal.addEventListener('abort', release, { once: true })
				if (signal.aborted) release()
				return {
					load: () => ({ status: this.workbenchStatus(signal) }),
					actions: {
						rotate: (input) => this.rotateCredentials(principal, signal, input),
					},
				}
			},
		})
	}

	private workbenchStatus(signal: AbortSignal): S3OperationsStatus {
		if (signal.aborted || !this.active) throw new S3NotRunningError()
		return {
			buckets: this.config.buckets.map((config) => {
				if (!this.states.has(config.id)) throw new S3NotRunningError()
				const backend = config.backend
				if (backend.type === 'local') {
					return {
						id: config.id,
						backend: 'local' as const,
						credentialRotation: 'not-applicable' as const,
					}
				}
				if (backend.credentials.type === 'anonymous') {
					return {
						id: config.id,
						backend: 'remote-anonymous' as const,
						credentialRotation: 'not-applicable' as const,
					}
				}
				return {
					id: config.id,
					backend: 'remote-vault' as const,
					credentialRotation: this.credentialReplacementSaved?.has(config.id)
						? ('restart-required' as const)
						: ('available' as const),
				}
			}),
		}
	}

	private rotateCredentials(
		principal: WorkbenchPrincipal,
		signal: AbortSignal,
		input: S3CredentialRotationInput,
	): Promise<WorkbenchContentActionResult> {
		return this.runCredentialMutation(async () => {
			if (!credentialRotationAuthorized(principal)) {
				return Object.freeze({
					ok: false as const,
					message: 'Credential rotation requires an authenticated Management principal.',
				})
			}
			if (signal.aborted || !this.active || !this.states.has(input.bucketId)) {
				return Object.freeze({
					ok: false as const,
					message: 'The selected S3 bucket is no longer running.',
				})
			}
			const bucket = this.states.get(input.bucketId)?.config
			const backend = bucket?.backend
			if (!backend || backend.type !== 'remote' || backend.credentials.type !== 'vault') {
				return Object.freeze({
					ok: false as const,
					message: 'Credential rotation requires a remote S3 bucket with a Vault reference.',
				})
			}
			let credentials: S3AccessKeyCredentials
			try {
				credentials = normalizeCredentials(input)
			} catch {
				return Object.freeze({ ok: false as const, message: 'The credentials are invalid.' })
			}
			const reference = backend.credentials
			const key = credentialKey(input.bucketId, reference)
			try {
				const vault = this.ctx.vault
				if (!vault) throw new Error('Vault is unavailable')
				await vault
					.kv(reference.namespace ? { namespace: reference.namespace } : undefined)
					.set(key, credentials)
				await vault.flush()
			} catch {
				return Object.freeze({
					ok: false as const,
					message: 'The replacement credentials could not be persisted.',
				})
			}
			this.credentialReplacementSaved?.add(input.bucketId)
			this.notifyWorkbenchDataChanged()
			return Object.freeze({
				ok: true as const,
				message: `Credentials for bucket "${input.bucketId}" were saved. Restart S3Plugin to apply them.`,
			})
		})
	}

	private runCredentialMutation<Result>(operation: () => Promise<Result>): Promise<Result> {
		const task = (this.credentialMutation ?? Promise.resolve()).then(operation)
		this.credentialMutation = task.then(
			(): undefined => undefined,
			(): undefined => undefined,
		)
		return task
	}

	private owner(): S3OwnerState {
		const context = this.ctx.caller ?? this.ctx
		let owner = this.owners.get(context)
		if (owner) {
			if (!owner.active) throw new S3NotRunningError()
			return owner
		}
		owner = { active: true, context, handles: new Map() }
		this.owners.set(context, owner)
		this.activeOwners.add(owner)
		const cleanupOwner = owner
		try {
			context.effects.defer(() => this.releaseOwner(cleanupOwner), {
				tag: 'S3Buckets',
				phase: 'shutdown',
			})
		} catch {
			this.releaseOwner(owner)
			throw new S3NotRunningError()
		}
		return owner
	}

	private assertRunning(): void {
		if (!this.active) throw new S3NotRunningError()
	}

	private assertActive(owner: S3OwnerState, state: S3BucketState): void {
		if (
			!this.active ||
			!owner.active ||
			this.owners.get(owner.context) !== owner ||
			this.states.get(state.config.id) !== state
		) {
			throw new S3NotRunningError()
		}
	}

	private releaseOwner(owner: S3OwnerState): void {
		if (!owner.active) return
		owner.active = false
		owner.handles.clear()
		this.activeOwners.delete(owner)
		if (this.owners.get(owner.context) === owner) this.owners.delete(owner.context)
	}

	private deactivate(): void {
		if (!this.active) return
		this.active = false
		for (const owner of this.activeOwners) this.releaseOwner(owner)
		this.workbenchDataListeners?.clear()
		this.workbenchDataListeners = undefined
		this.credentialReplacementSaved = undefined
		this.credentialMutation = undefined
	}

	private notifyWorkbenchDataChanged(): void {
		for (const dataChanged of this.workbenchDataListeners ?? []) dataChanged()
	}
}

class S3BucketHandle implements S3Bucket {
	constructor(
		readonly id: string,
		private readonly currentClient: () => S3Client,
	) {}

	get client(): S3Client {
		return this.currentClient()
	}
}

function credentialKey(
	bucketId: string,
	credentials: Extract<RemoteCredentials, { type: 'vault' }>,
) {
	return (
		credentials.key ?? (bucketId === 'default' ? 's3.credentials' : `s3.${bucketId}.credentials`)
	)
}

function lifecycleFetch(lifecycleSignal: AbortSignal): typeof fetch {
	return ((input, init): Promise<Response> => {
		const requestSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
		const signal = requestSignal
			? AbortSignal.any([lifecycleSignal, requestSignal])
			: lifecycleSignal
		return fetch(input, { ...init, signal })
	}) as typeof fetch
}

function normalizeBucketId(value: string): string {
	if (typeof value !== 'string' || !isS3BucketId(value)) {
		throw new TypeError('S3 bucket ID is invalid.')
	}
	return value
}

function normalizeCredentials(value: unknown): S3AccessKeyCredentials {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new TypeError('Expected an S3 access-key credential object.')
	}
	const candidate = value as Record<string, unknown>
	if (
		typeof candidate.accessKeyId !== 'string' ||
		candidate.accessKeyId.trim().length === 0 ||
		candidate.accessKeyId.length > 256 ||
		/[\r\n]/.test(candidate.accessKeyId) ||
		typeof candidate.secretAccessKey !== 'string' ||
		candidate.secretAccessKey.trim().length === 0 ||
		candidate.secretAccessKey.length > 4_096 ||
		/[\r\n]/.test(candidate.secretAccessKey)
	) {
		throw new TypeError('Expected valid S3 access-key credentials.')
	}
	return Object.freeze({
		accessKeyId: candidate.accessKeyId,
		secretAccessKey: candidate.secretAccessKey,
	})
}

function credentialRotationAuthorized(principal: WorkbenchPrincipal): boolean {
	return (
		principal.provider.length > 0 &&
		principal.subject.length > 0 &&
		!(principal.provider === 'local' && principal.subject === 'local')
	)
}
