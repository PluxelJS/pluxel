import { resolve } from 'node:path'
import { f, Plugin, v } from '@pluxel/runtime'
import type { VaultKvHandle } from '@pluxel/runtime/services/vault'
import { S3mini } from 's3mini'
import { S3, type S3Client, S3NotRunningError } from './capability.ts'
import { LocalS3Client } from './local.ts'

const MEBIBYTE = 1024 * 1024

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
			label: 'Local S3 root',
			description: 'Root for locally emulated buckets. Production should place it outside dist/.',
		}),
	),
	bucketName: v.pipe(v.optional(LocalBucketName, 'local'), f.formMeta({ label: 'Bucket name' })),
	syncWrites: v.pipe(
		v.optional(v.boolean(), true),
		f.formMeta({
			label: 'Flush writes',
			description: 'fsync completed object files and directory entries where supported.',
		}),
	),
})

const RemoteCredentialsConfig = v.variant('type', [
	v.object({ type: v.literal('anonymous') }),
	v.object({
		type: v.literal('vault'),
		key: v.pipe(v.optional(VaultReference, 's3.credentials'), f.formMeta({ label: 'Vault key' })),
		namespace: v.pipe(
			v.optional(VaultReference),
			f.formMeta({
				label: 'Vault namespace',
				description: 'When omitted, use this S3Plugin instance namespace.',
			}),
		),
	}),
])

const RemoteBackendConfig = v.object({
	type: v.literal('remote'),
	endpoint: v.pipe(
		S3Endpoint,
		f.formMeta({
			label: 'S3 endpoint',
			description:
				'Bucket endpoint in path-style or virtual-hosted-style form. Credentials are separate.',
		}),
	),
	region: v.pipe(
		v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(128)), 'auto'),
		f.formMeta({ label: 'S3 region' }),
	),
	credentials: RemoteCredentialsConfig,
	requestSizeInBytes: v.pipe(
		v.optional(v.pipe(v.number(), v.integer(), v.minValue(1)), 8 * MEBIBYTE),
		f.formMeta({
			label: 'Read request size',
			description: 'Default byte range used by s3mini for ranged reads.',
		}),
	),
	requestAbortTimeout: v.pipe(
		v.optional(v.pipe(v.number(), v.integer(), v.minValue(1)), 30_000),
		f.formMeta({
			label: 'Request timeout',
			description: 'Timeout for each underlying S3 request.',
		}),
	),
	minPartSize: v.pipe(
		v.optional(
			v.pipe(v.number(), v.integer(), v.minValue(5 * MEBIBYTE), v.maxValue(5 * 1024 * MEBIBYTE)),
			8 * MEBIBYTE,
		),
		f.formMeta({
			label: 'Multipart part size',
			description: 'Minimum part size used by s3mini multipart uploads.',
		}),
	),
})

export const S3Config = v.object({
	backend: v.optional(v.variant('type', [LocalBackendConfig, RemoteBackendConfig]), {
		type: 'local',
		rootDir: '.pluxel/s3',
		bucketName: 'local',
		syncWrites: true,
	}),
})

export type S3PluginConfig = v.InferOutput<typeof S3Config>
export type S3AccessKeyCredentials = Readonly<{
	accessKeyId: string
	secretAccessKey: string
}>

export class S3CredentialsError extends Error {
	override name = 'S3CredentialsError'
	readonly code = 'S3_CREDENTIALS_ERROR'

	constructor(
		readonly reason: 'missing' | 'invalid' | 'unavailable',
		readonly key: string,
		cause?: unknown,
	) {
		super(`S3 credentials at Vault key "${key}" are ${reason}.`, { cause })
	}
}

type RemoteBackend = Extract<S3PluginConfig['backend'], { type: 'remote' }>
type LocalBackend = Extract<S3PluginConfig['backend'], { type: 'local' }>
type RemoteCredentials = RemoteBackend['credentials']

/** One official S3 provider; configuration selects local emulation or a real s3mini client. */
@Plugin(S3)
export class S3Plugin extends S3 {
	private readonly config = this.configs.use(S3Config)
	private readonly holder: { client?: S3Client } = {}

	override get client(): S3Client {
		const client = this.holder.client
		if (!client) throw new S3NotRunningError()
		return client
	}

	protected override async init(signal: AbortSignal): Promise<void> {
		const backend = this.config.backend
		if (backend.type === 'local') {
			await this.initLocal(backend, signal)
			return
		}
		await this.initRemote(backend, signal)
	}

	private async initLocal(config: LocalBackend, signal: AbortSignal): Promise<void> {
		signal.throwIfAborted()
		const client = new LocalS3Client({
			rootDir: resolve(process.cwd(), config.rootDir),
			bucketName: config.bucketName,
			syncWrites: config.syncWrites,
		})
		await client.createBucket()
		if (signal.aborted) {
			await client.dispose()
			signal.throwIfAborted()
		}
		await this.activate(client, () => client.dispose(), 'LocalS3Client')
	}

	private async initRemote(config: RemoteBackend, signal: AbortSignal): Promise<void> {
		const credentials = await this.resolveCredentials(config.credentials)
		signal.throwIfAborted()
		const lifecycle = new AbortController()
		const client = new S3mini({
			accessKeyId: credentials?.accessKeyId ?? '',
			secretAccessKey: credentials?.secretAccessKey ?? '',
			endpoint: config.endpoint,
			region: config.region,
			requestSizeInBytes: config.requestSizeInBytes,
			requestAbortTimeout: config.requestAbortTimeout,
			minPartSize: config.minPartSize,
			fetch: lifecycleFetch(lifecycle.signal),
		})
		await this.activate(client, () => lifecycle.abort(new S3NotRunningError()), 'S3miniClient')
	}

	private async resolveCredentials(
		config: RemoteCredentials,
	): Promise<S3AccessKeyCredentials | undefined> {
		if (config.type === 'anonymous') return undefined
		let value: unknown
		try {
			const credentials: VaultKvHandle = this.ctx.vault.kv(
				config.namespace ? { namespace: config.namespace } : undefined,
			)
			value = await credentials.get(config.key)
		} catch (error) {
			throw new S3CredentialsError('unavailable', config.key, error)
		}
		if (value === undefined) throw new S3CredentialsError('missing', config.key)
		try {
			return normalizeCredentials(value)
		} catch (error) {
			throw new S3CredentialsError('invalid', config.key, error)
		}
	}

	private async activate(
		client: S3Client,
		disposeClient: () => void | Promise<void>,
		tag: string,
	): Promise<void> {
		let disposed = false
		const dispose = async (): Promise<void> => {
			if (disposed) return
			disposed = true
			if (this.holder.client === client) this.holder.client = undefined
			await disposeClient()
		}
		try {
			this.ctx.effects.defer(dispose, { tag })
			this.holder.client = client
		} catch (error) {
			await dispose()
			throw error
		}
	}
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
