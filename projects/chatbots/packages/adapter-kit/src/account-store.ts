import { normalizeBotId } from './registry.ts'

export type BotAccountConfig = {
	id: string
	token: string
	apiBase: string
}

export type BotAccountInput = {
	id: string
	token?: string
	apiBase?: string
}

export interface BotAccountKv {
	get<Value>(key: string): Promise<Value | undefined>
	set<Value>(key: string, value: Value): Promise<void>
	delete(key: string): Promise<void>
	keys(): Promise<string[]>
}

type StoredBotAccount = Omit<BotAccountConfig, 'id'>

const ACCOUNT_PREFIX = 'accounts.'

/** Atomic Vault-KV storage for one platform's Bot accounts. */
export class BotAccountStore {
	constructor(
		private readonly kv: BotAccountKv,
		private readonly defaultApiBase: string,
	) {}

	async list(): Promise<string[]> {
		const pattern = new RegExp(
			`^${escapeRegExp(ACCOUNT_PREFIX)}([a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?)$`,
		)
		const ids: string[] = []
		for (const key of await this.kv.keys()) {
			const match = pattern.exec(key)
			if (match) ids.push(match[1]!)
		}
		return ids.sort()
	}

	async read(idInput: string): Promise<BotAccountConfig | undefined> {
		const id = normalizeBotId(idInput)
		const value = await this.kv.get<unknown>(this.key(id))
		if (value === undefined) return undefined
		if (!isStoredAccount(value)) throw new Error(`Invalid Bot account configuration: ${id}`)
		const apiBase = normalizeBaseUrl(value.apiBase, this.defaultApiBase)
		if (value.token !== value.token.trim() || value.apiBase !== apiBase)
			throw new Error(`Invalid Bot account configuration: ${id}`)
		return {
			id,
			token: value.token,
			apiBase,
		}
	}

	async upsert(input: BotAccountInput): Promise<BotAccountConfig> {
		const id = normalizeBotId(input.id)
		const current = await this.read(id)
		const token = input.token?.trim() || current?.token
		if (!token) throw new Error('Bot token is required')
		const apiBase = normalizeBaseUrl(input.apiBase ?? current?.apiBase, this.defaultApiBase)
		await this.kv.set<StoredBotAccount>(this.key(id), { token, apiBase })
		return { id, token, apiBase }
	}

	async remove(idInput: string): Promise<void> {
		const id = normalizeBotId(idInput)
		await this.kv.delete(this.key(id))
	}

	private key(id: string): string {
		return `${ACCOUNT_PREFIX}${id}`
	}
}

function normalizeBaseUrl(value: string | undefined, fallback: string): string {
	const normalized = (value?.trim() || fallback).replace(/\/+$/, '')
	let url: URL
	try {
		url = new URL(normalized)
	} catch {
		throw new Error(`Invalid Bot API base URL: ${normalized}`)
	}
	if (
		(url.protocol !== 'http:' && url.protocol !== 'https:') ||
		url.username ||
		url.password ||
		url.search ||
		url.hash
	)
		throw new Error(`Invalid Bot API base URL: ${normalized}`)
	return url.toString().replace(/\/+$/, '')
}

function isStoredAccount(value: unknown): value is StoredBotAccount {
	if (!value || typeof value !== 'object') return false
	const candidate = value as Partial<StoredBotAccount>
	return (
		typeof candidate.token === 'string' &&
		candidate.token.trim().length > 0 &&
		typeof candidate.apiBase === 'string' &&
		candidate.apiBase.trim().length > 0
	)
}

function escapeRegExp(value: string): string {
	return value.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
