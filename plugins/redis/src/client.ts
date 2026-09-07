import { BasePlugin, f, formatPluginNodeReference, Plugin, type Context, v } from '@pluxel/runtime'
import {
	createClient,
	type RedisClientType,
	type RedisClusterType,
	type RedisSentinelType,
} from 'redis'
import { RedisScripts } from './scripts.ts'
import { isRedisConnectionId } from './validation.ts'
import { RedisWorkbench, type RedisWorkbenchStatus } from './workbench.ts'

const MAX_CONNECTIONS = 64

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

const RedisConnectionId = v.pipe(
	v.string(),
	v.check(
		isRedisConnectionId,
		'Connection ID must start with a lowercase letter and contain at most 64 lowercase letters, digits, dots, underscores, or hyphens',
	),
)

const RedisUrl = v.pipe(
	v.string(),
	v.url(),
	v.check(
		isCredentialFreeRedisUrl,
		'Redis URL must use redis:// or rediss:// without credentials, database path, query, or hash',
	),
)

const RedisConnectionConfig = v.object({
	id: v.pipe(RedisConnectionId, f.formMeta({ title: 'Connection ID' })),
	url: v.pipe(v.optional(RedisUrl, 'redis://127.0.0.1:6379'), f.formMeta({ title: 'URL' })),
	database: v.pipe(
		v.optional(v.pipe(v.number(), v.integer(), v.minValue(0)), 0),
		f.formMeta({ title: 'Database' }),
	),
	connectTimeoutMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1)), 10_000),
	commandQueueMaxLength: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1)), 10_000),
	disableOfflineQueue: v.optional(v.boolean(), true),
	pingIntervalMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0)), 0),
})

const RedisConnections = v.pipe(
	v.array(RedisConnectionConfig),
	v.minLength(1, 'At least one Redis connection is required'),
	v.maxLength(MAX_CONNECTIONS, `At most ${MAX_CONNECTIONS} Redis connections are allowed`),
	v.check(hasUniqueConnectionIds, 'Redis connection IDs must be unique'),
)

export const RedisConfig = v.object({
	connections: v.pipe(
		v.optional(RedisConnections, [
			{
				id: 'default',
				url: 'redis://127.0.0.1:6379',
				database: 0,
				connectTimeoutMs: 10_000,
				commandQueueMaxLength: 10_000,
				disableOfflineQueue: true,
				pingIntervalMs: 0,
			},
		]),
		f.formMeta({ title: 'Connections', description: 'Bounded named Redis connections.' }),
		f.arrayMeta({ layout: 'list', addLabel: 'Add connection', itemLabel: 'Connection' }),
	),
})

export type RedisPluginConfig = v.InferOutput<typeof RedisConfig>
export type RedisConnectionConfig = RedisPluginConfig['connections'][number]
export type RedisClient = RedisClientType | RedisClusterType | RedisSentinelType

export interface RedisConnection {
	readonly id: string
	readonly client: RedisClient
	readonly scripts: RedisScripts
}

export class RedisNotRunningError extends Error {
	override name = 'RedisNotRunningError'
	readonly code = 'REDIS_NOT_RUNNING'

	constructor() {
		super('Redis capability belongs to a stopped provider or consumer.')
	}
}

export class RedisConnectionNotFoundError extends Error {
	override name = 'RedisConnectionNotFoundError'
	readonly code = 'REDIS_CONNECTION_NOT_FOUND'

	constructor(readonly connectionId: string) {
		super(`Redis connection "${connectionId}" is not configured.`)
	}
}

export class RedisConnectionError extends Error {
	override name = 'RedisConnectionError'
	readonly code = 'REDIS_CONNECTION_ERROR'

	constructor(
		readonly connectionId: string,
		url: string,
		database: number,
		cause: unknown,
	) {
		const endpoint = new URL(url).host
		super(`Redis connection "${connectionId}" to ${endpoint} database ${database} failed.`, {
			cause,
		})
	}
}

/** Named Redis connection catalog. Consumers select a configured connection explicitly. */
export abstract class Redis extends BasePlugin {
	abstract connection(connectionId?: string): RedisConnection
	abstract connectionIds(): readonly string[]
}

type RedisConnectionState = {
	readonly config: RedisConnectionConfig
	readonly client: RedisClientType
	workbench?: {
		recentErrorType: string | null
		ping: RedisWorkbenchStatus['connections'][number]['ping']
	}
}

type RedisOwnerState = {
	active: boolean
	readonly context: Context
	readonly handles: Map<string, RedisConnection>
}

/** Credential-free standalone provider for a bounded catalog of named Redis connections. */
@Plugin(Redis)
export class RedisPlugin extends Redis {
	private readonly config = this.configs.use(RedisConfig)
	private ids: readonly string[] = Object.freeze([])
	private readonly states = new Map<string, RedisConnectionState>()
	private readonly owners = new WeakMap<Context, RedisOwnerState>()
	private readonly activeOwners = new Set<RedisOwnerState>()
	private active = false
	private workbenchDataListeners?: Set<() => void>

	override connection(connectionId = 'default'): RedisConnection {
		this.assertRunning()
		const id = normalizeConnectionId(connectionId)
		const state = this.states.get(id)
		if (!state) throw new RedisConnectionNotFoundError(id)

		const owner = this.owner()
		const existing = owner.handles.get(id)
		if (existing) return existing
		const handle = new RedisConnectionHandle(id, () => {
			this.assertActive(owner, state)
			return state.client
		})
		owner.handles.set(id, handle)
		return handle
	}

	override connectionIds(): readonly string[] {
		this.assertRunning()
		return this.ids
	}

	protected override async init(signal: AbortSignal): Promise<void> {
		this.ids = Object.freeze(this.config.connections.map((connection) => connection.id))
		const startup = new AbortController()
		const startupSignal = AbortSignal.any([signal, startup.signal])
		const results = await Promise.allSettled(
			this.config.connections.map(async (connection) => {
				try {
					await this.startConnection(connection, startupSignal)
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
				tag: 'RedisConnectionCatalog',
				phase: 'shutdown',
			})
		} catch (error) {
			this.deactivate()
			throw error
		}
		this.publishWorkbench()
	}

	private async startConnection(config: RedisConnectionConfig, signal: AbortSignal): Promise<void> {
		signal.throwIfAborted()
		const client = createClient({
			url: config.url,
			database: config.database,
			name: `pluxel:${formatPluginNodeReference(this.ctx.pluginInfo.nodeAddress)}:${config.id}`,
			commandsQueueMaxLength: config.commandQueueMaxLength,
			disableOfflineQueue: config.disableOfflineQueue,
			pingInterval: config.pingIntervalMs || undefined,
			socket: { connectTimeout: config.connectTimeoutMs },
		})
		const state: RedisConnectionState = {
			config,
			client,
			workbench: this.ctx.workbench
				? {
						recentErrorType: null,
						ping: { state: 'not-run', latencyMs: null, errorType: null },
					}
				: undefined,
		}
		let disposed = false
		const onError = (error: Error): void => {
			if (disposed) return
			this.ctx.logger.error('Redis client error', { connectionId: config.id, error })
			if (!state.workbench) return
			state.workbench.recentErrorType = safeErrorType(error)
			this.notifyWorkbenchDataChanged()
		}
		client.on('error', onError)

		const dispose = async (): Promise<void> => {
			if (disposed) return
			disposed = true
			client.off('error', onError)
			if (this.states.get(config.id) === state) this.states.delete(config.id)
			try {
				if (client.isOpen) await client.close()
				else client.destroy()
			} catch {
				try {
					client.destroy()
				} catch {}
			}
		}
		this.ctx.effects.defer(dispose, { tag: `RedisClient:${config.id}` })

		const abort = (): void => client.destroy()
		signal.addEventListener('abort', abort, { once: true })
		try {
			await connectWithin(client, config.connectTimeoutMs)
			signal.throwIfAborted()
		} catch (error) {
			await dispose()
			throw new RedisConnectionError(config.id, config.url, config.database, error)
		} finally {
			signal.removeEventListener('abort', abort)
		}

		if (state.workbench) {
			const connectionChanged = (): void => {
				if (client.isReady) state.workbench!.recentErrorType = null
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
				{ tag: `RedisWorkbenchEvents:${config.id}` },
			)
		}
		this.states.set(config.id, state)
	}

	private publishWorkbench(): void {
		const workbench = this.ctx.workbench
		if (!workbench) return
		this.workbenchDataListeners = new Set()
		workbench.publish(RedisWorkbench, {
			connections: ({ signal, dataChanged }) => {
				const release = (): void => {
					this.workbenchDataListeners?.delete(dataChanged)
				}
				this.workbenchDataListeners.add(dataChanged)
				signal.addEventListener('abort', release, { once: true })
				if (signal.aborted) release()
				return {
					load: () => ({ status: this.workbenchStatus(signal) }),
					actions: {
						ping: ({ connectionId, payload }) => this.pingRedis(signal, connectionId, payload),
					},
				}
			},
		})
	}

	private workbenchStatus(signal: AbortSignal): RedisWorkbenchStatus {
		if (signal.aborted || !this.active) throw new RedisNotRunningError()
		return {
			connections: this.config.connections.map((config) => {
				const state = this.states.get(config.id)
				if (!state?.workbench) throw new RedisNotRunningError()
				return {
					id: config.id,
					database: config.database,
					connection: state.client.isReady
						? 'ready'
						: state.client.isOpen
							? 'reconnecting'
							: 'closed',
					recentErrorType: state.workbench.recentErrorType,
					ping: state.workbench.ping,
				}
			}),
		}
	}

	private async pingRedis(
		signal: AbortSignal,
		connectionId: string,
		payload: string,
	): Promise<{ ok: true; message: string } | { ok: false; message: string }> {
		if (signal.aborted || !this.active) {
			return { ok: false, message: 'The Redis provider is no longer running.' }
		}
		const state = this.states.get(connectionId)
		if (!state?.workbench) {
			return { ok: false, message: 'The selected Redis connection is not configured.' }
		}
		const startedAt = performance.now()
		try {
			const reply = payload ? await state.client.ping(payload) : await state.client.ping()
			const expected = payload || 'PONG'
			if (reply !== expected) throw new TypeError('Redis returned an unexpected PING reply.')
			const latencyMs = Math.max(0, Math.round(performance.now() - startedAt))
			state.workbench.ping = { state: 'succeeded', latencyMs, errorType: null }
			this.notifyWorkbenchDataChanged()
			return {
				ok: true,
				message: `Redis connection "${connectionId}" replied in ${latencyMs} ms.`,
			}
		} catch (error) {
			state.workbench.ping = {
				state: 'failed',
				latencyMs: null,
				errorType: safeErrorType(error),
			}
			this.notifyWorkbenchDataChanged()
			return { ok: false, message: 'Redis PING failed. Check the Plugin logs.' }
		}
	}

	private owner(): RedisOwnerState {
		const context = this.ctx.caller ?? this.ctx
		let owner = this.owners.get(context)
		if (owner) {
			if (!owner.active) throw new RedisNotRunningError()
			return owner
		}
		owner = { active: true, context, handles: new Map() }
		this.owners.set(context, owner)
		this.activeOwners.add(owner)
		const cleanupOwner = owner
		try {
			context.effects.defer(() => this.releaseOwner(cleanupOwner), {
				tag: 'RedisConnections',
				phase: 'shutdown',
			})
		} catch {
			this.releaseOwner(owner)
			throw new RedisNotRunningError()
		}
		return owner
	}

	private assertRunning(): void {
		if (!this.active) throw new RedisNotRunningError()
	}

	private assertActive(owner: RedisOwnerState, state: RedisConnectionState): void {
		if (
			!this.active ||
			!owner.active ||
			this.owners.get(owner.context) !== owner ||
			this.states.get(state.config.id) !== state ||
			!state.client.isOpen
		) {
			throw new RedisNotRunningError()
		}
	}

	private releaseOwner(owner: RedisOwnerState): void {
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
	}

	private notifyWorkbenchDataChanged(): void {
		for (const changed of this.workbenchDataListeners ?? []) changed()
	}
}

class RedisConnectionHandle implements RedisConnection {
	readonly scripts: RedisScripts

	constructor(
		readonly id: string,
		private readonly currentClient: () => RedisClient,
	) {
		this.scripts = new RedisScripts(currentClient)
	}

	get client(): RedisClient {
		return this.currentClient()
	}
}

function hasUniqueConnectionIds(
	connections: {
		id: string
		url?: string
		database?: number
		connectTimeoutMs?: number
		commandQueueMaxLength?: number
		disableOfflineQueue?: boolean
		pingIntervalMs?: number
	}[],
): boolean {
	return new Set(connections.map((connection) => connection.id)).size === connections.length
}

function normalizeConnectionId(value: string): string {
	if (typeof value !== 'string' || !isRedisConnectionId(value)) {
		throw new TypeError('Redis connection ID is invalid.')
	}
	return value
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
