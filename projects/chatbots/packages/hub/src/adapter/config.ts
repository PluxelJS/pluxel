import { normalizeBotId } from './registry.ts'

export type TokenBotConfig = {
	id: string
	token: string
	apiBase: string
}

export type TokenBotConfigInput = {
	id: string
	token?: string
	apiBase?: string
}

export interface BotConfigKv {
	get<Value>(key: string): Promise<Value | undefined>
	set<Value>(key: string, value: Value): Promise<void>
	delete(key: string): Promise<void>
	keys(): Promise<string[]>
}

export type TokenBotConfigStoreOptions = {
	defaultApiBase: string
	prefix?: string
	legacyTokenKey?: string
	legacyApiBaseKey?: string
	defaultBotId?: string
}

/** Optional Vault-KV layout helper for token + API-base platform accounts. */
export class TokenBotConfigStore {
	private readonly prefix: string
	private readonly defaultBotId: string
	private readonly mutationTails = new Map<string, Promise<void>>()

	constructor(
		private readonly kv: BotConfigKv,
		private readonly options: TokenBotConfigStoreOptions,
	) {
		this.prefix = options.prefix ?? 'bots.'
		this.defaultBotId = normalizeBotId(options.defaultBotId ?? 'default')
	}

	async list(): Promise<string[]> {
		const ids = new Set<string>()
		const escaped = escapeRegExp(this.prefix)
		const pattern = new RegExp(`^${escaped}([a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?)\\.token$`)
		for (const key of await this.kv.keys()) {
			const match = pattern.exec(key)
			if (match) ids.add(match[1]!)
		}
		return [...ids].sort()
	}

	async read(idInput: string): Promise<TokenBotConfig | undefined> {
		const id = normalizeBotId(idInput)
		const token = await this.kv.get<string>(this.key(id, 'token'))
		if (!token) return undefined
		return {
			id,
			token,
			apiBase: (await this.kv.get<string>(this.key(id, 'api_base'))) ?? this.options.defaultApiBase,
		}
	}

	async upsert(input: TokenBotConfigInput): Promise<TokenBotConfig> {
		const id = normalizeBotId(input.id)
		return this.mutate(id, async () => {
			const current = await this.read(id)
			const token = input.token?.trim() || current?.token
			if (!token) throw new Error('Bot token is required')
			const apiBase = normalizeBaseUrl(
				input.apiBase ?? current?.apiBase,
				this.options.defaultApiBase,
			)
			await Promise.all([
				this.kv.set(this.key(id, 'token'), token),
				this.kv.set(this.key(id, 'api_base'), apiBase),
			])
			return { id, token, apiBase }
		})
	}

	async remove(idInput: string): Promise<string> {
		const id = normalizeBotId(idInput)
		return this.mutate(id, async () => {
			await Promise.all([
				this.kv.delete(this.key(id, 'token')),
				this.kv.delete(this.key(id, 'api_base')),
			])
			return id
		})
	}

	async migrateLegacy(): Promise<boolean> {
		const tokenKey = this.options.legacyTokenKey
		if (!tokenKey) return false
		const token = await this.kv.get<string>(tokenKey)
		if (!token) return false
		const apiBaseKey = this.options.legacyApiBaseKey
		const existing = await this.read(this.defaultBotId)
		if (!existing) {
			const legacyApiBase = apiBaseKey ? await this.kv.get<string>(apiBaseKey) : undefined
			await this.upsert({ id: this.defaultBotId, token, apiBase: legacyApiBase })
		}
		await Promise.all([
			this.kv.delete(tokenKey),
			...(apiBaseKey ? [this.kv.delete(apiBaseKey)] : []),
		])
		return true
	}

	private key(id: string, field: 'token' | 'api_base'): string {
		return `${this.prefix}${id}.${field}`
	}

	private mutate<Value>(id: string, task: () => Promise<Value>): Promise<Value> {
		const previous = this.mutationTails.get(id) ?? Promise.resolve()
		const current = previous.then(task, task)
		const tail: Promise<void> = current.then(
			(): undefined => undefined,
			(): undefined => undefined,
		)
		this.mutationTails.set(id, tail)
		void tail.then((): undefined => {
			if (this.mutationTails.get(id) === tail) this.mutationTails.delete(id)
			return undefined
		})
		return current
	}
}

function normalizeBaseUrl(value: string | undefined, fallback: string): string {
	return (value?.trim() || fallback).replace(/\/+$/, '')
}

function escapeRegExp(value: string): string {
	return value.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
