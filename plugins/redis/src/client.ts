import { BasePlugin, formatPluginNodeReference, Plugin, v } from '@pluxel/runtime'
import {
	createClient,
	type RedisClientType,
	type RedisClusterType,
	type RedisSentinelType,
} from 'redis'
import { RedisScripts } from './scripts.ts'
import { RedisWorkbench, type RedisWorkbenchStatus } from './workbench.ts'

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
export abstract class Redis extends BasePlugin {
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
@Plugin(Redis, { forkable: true })
export class RedisPlugin extends Redis {
	private readonly config = this.configs.use(RedisConfig)
	private readonly holder: { client?: RedisClientType } = {}
	private readonly workbenchDataListeners = new Set<() => void>()
	private recentErrorType: string | null = null
	private pingStatus: RedisWorkbenchStatus['ping'] = {
		state: 'not-run',
		latencyMs: null,
		errorType: null,
	}

	override get client(): RedisClientType {
		const client = this.holder.client
		if (!client?.isOpen) throw new RedisNotRunningError()
		return client
	}

	protected override async init(signal: AbortSignal): Promise<void> {
		const client = createClient({
			url: this.config.url,
			database: this.config.database,
			name: `pluxel:${formatPluginNodeReference(this.ctx.pluginInfo.nodeAddress)}`,
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
		const workbench = this.ctx.workbench

		client.on('error', (error) => {
			if (disposed) return
			this.ctx.logger.error('Redis client error', { error })
			if (!workbench) return
			this.recentErrorType = safeErrorType(error)
			this.notifyWorkbenchDataChanged()
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

		if (workbench) {
			const connectionChanged = (): void => {
				if (client.isReady) this.recentErrorType = null
				this.notifyWorkbenchDataChanged()
			}
			client.on('ready', connectionChanged)
			client.on('reconnecting', connectionChanged)
			client.on('end', connectionChanged)
			this.ctx.effects.defer(
				() => {
					client.off('ready', connectionChanged)
					client.off('reconnecting', connectionChanged)
					client.off('end', connectionChanged)
				},
				{ tag: 'RedisWorkbenchEvents' },
			)
		}

		this.ctx.workbench?.publish(RedisWorkbench, {
			connection: ({ signal: contentSignal, dataChanged }) => {
				const release = (): void => {
					this.workbenchDataListeners.delete(dataChanged)
				}
				this.workbenchDataListeners.add(dataChanged)
				contentSignal.addEventListener('abort', release, { once: true })
				if (contentSignal.aborted) release()
				return {
					load: () => ({ status: this.workbenchStatus(client) }),
					actions: {
						ping: async ({ payload }) => this.pingRedis(client, payload),
					},
				}
			},
		})
	}

	private workbenchStatus(client: RedisClientType): RedisWorkbenchStatus {
		return {
			connection: client.isReady ? 'ready' : client.isOpen ? 'reconnecting' : 'closed',
			recentErrorType: this.recentErrorType,
			ping: this.pingStatus,
		}
	}

	private async pingRedis(
		client: RedisClientType,
		payload: string,
	): Promise<{ ok: true; message: string } | { ok: false; message: string }> {
		const startedAt = performance.now()
		try {
			const reply = payload ? await client.ping(payload) : await client.ping()
			const expected = payload || 'PONG'
			if (reply !== expected) throw new TypeError('Redis returned an unexpected PING reply.')
			const latencyMs = Math.max(0, Math.round(performance.now() - startedAt))
			this.pingStatus = { state: 'succeeded', latencyMs, errorType: null }
			this.notifyWorkbenchDataChanged()
			return { ok: true, message: `Redis replied in ${latencyMs} ms.` }
		} catch (error) {
			this.pingStatus = { state: 'failed', latencyMs: null, errorType: safeErrorType(error) }
			this.notifyWorkbenchDataChanged()
			return { ok: false, message: 'Redis PING failed. Check the Plugin logs.' }
		}
	}

	private notifyWorkbenchDataChanged(): void {
		for (const changed of this.workbenchDataListeners) changed()
	}
}

function safeErrorType(error: unknown): string {
	const value = error instanceof Error ? error.name : typeof error
	return (value || 'Error').slice(0, 128)
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
