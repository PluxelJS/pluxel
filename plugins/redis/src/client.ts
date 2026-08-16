import { formatPluginNodeAddress, ForkablePlugin, Plugin, v } from '@pluxel/runtime'
import {
	createClient,
	type RedisClientType,
	type RedisClusterType,
	type RedisSentinelType,
} from 'redis'
import { RedisScripts } from './scripts.ts'

function isCredentialFreeRedisUrl(value: string): boolean {
	const url = new URL(value)
	return (
		(url.protocol === 'redis:' || url.protocol === 'rediss:') &&
		!url.username &&
		!url.password &&
		(url.pathname === '' || url.pathname === '/') &&
		!url.search &&
		!url.hash
	)
}

const RedisUrl = v.pipe(
	v.string(),
	v.url(),
	v.check(
		isCredentialFreeRedisUrl,
		'Redis URL must use redis:// or rediss:// without credentials, database path, query, or hash',
	),
)

export const RedisConfig = v.object({
	url: v.optional(RedisUrl, 'redis://127.0.0.1:6379'),
	database: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0)), 0),
	connectTimeoutMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1)), 10_000),
	commandQueueMaxLength: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1)), 10_000),
	disableOfflineQueue: v.optional(v.boolean(), true),
	pingIntervalMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0)), 0),
})

export type RedisPluginConfig = v.InferOutput<typeof RedisConfig>
export type RedisClient = RedisClientType | RedisClusterType | RedisSentinelType

export class RedisNotRunningError extends Error {
	override name = 'RedisNotRunningError'

	constructor() {
		super('Redis capability belongs to a stopped provider.')
	}
}

export class RedisConnectionError extends Error {
	override name = 'RedisConnectionError'

	constructor(url: string, database: number, cause: unknown) {
		const endpoint = new URL(url).host
		super(`Redis connection to ${endpoint} database ${database} failed.`, { cause })
	}
}

/** Raw Redis capability. Consumers depend on this token; the host selects a provider. */
export abstract class Redis extends ForkablePlugin {
	private readonly scriptsByOwner = new WeakMap<object, RedisScripts>()

	abstract get client(): RedisClient

	get scripts(): RedisScripts {
		const owner = this.ctx.caller ?? this.ctx
		let scripts = this.scriptsByOwner.get(owner)
		if (!scripts) {
			scripts = new RedisScripts(() => this.client)
			this.scriptsByOwner.set(owner, scripts)
		}
		return scripts
	}
}

/**
 * Default credential-free standalone Redis provider.
 * Authenticated, Sentinel, Cluster, or platform-bound deployments can provide another
 * `@Plugin(Redis, ...)` implementation without changing consumers.
 */
@Plugin(Redis, { displayName: 'RedisPlugin' })
export class RedisPlugin extends Redis {
	private readonly config = this.configs.use(RedisConfig)
	private readonly holder: { client?: RedisClientType } = {}

	override get client(): RedisClientType {
		const client = this.holder.client
		if (!client?.isOpen) throw new RedisNotRunningError()
		return client
	}

	protected override async init(signal: AbortSignal): Promise<void> {
		const client = createClient({
			url: this.config.url,
			database: this.config.database,
			name: `pluxel:${formatPluginNodeAddress(this.ctx.pluginInfo.nodeAddress)}`,
			commandsQueueMaxLength: this.config.commandQueueMaxLength,
			disableOfflineQueue: this.config.disableOfflineQueue,
			pingInterval: this.config.pingIntervalMs || undefined,
			socket: { connectTimeout: this.config.connectTimeoutMs },
		})
		this.holder.client = client

		let disposed = false
		const dispose = async (): Promise<void> => {
			if (disposed) return
			disposed = true
			if (this.holder.client === client) this.holder.client = undefined
			try {
				if (client.isOpen) await client.close()
				else client.destroy()
			} catch {
				try {
					client.destroy()
				} catch {}
			}
		}
		this.ctx.effects.defer(dispose, { tag: 'RedisClient' })

		client.on('error', (error) => {
			if (!disposed) this.ctx.logger.error('Redis client error', { error })
		})

		const abort = () => client.destroy()
		signal.addEventListener('abort', abort, { once: true })
		try {
			await connectWithin(client, this.config.connectTimeoutMs)
		} catch (error) {
			await dispose()
			throw new RedisConnectionError(this.config.url, this.config.database, error)
		} finally {
			signal.removeEventListener('abort', abort)
		}
	}
}

async function connectWithin(client: RedisClientType, timeoutMs: number): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined
	try {
		await Promise.race([
			client.connect().then((): undefined => undefined),
			new Promise<never>((_, reject) => {
				timer = setTimeout((): void => {
					reject(new Error(`Redis connection did not become ready within ${timeoutMs}ms.`))
				}, timeoutMs)
			}),
		])
	} finally {
		if (timer) clearTimeout(timer)
	}
}
