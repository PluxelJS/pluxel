import { BasePlugin, Plugin } from '@pluxel/core'
import { Result, TaggedError } from '@pluxel/core/better-result'
import { Cache, type CacheNamespace } from '../../src/index.ts'

export type Account = Readonly<{ id: string; name: string }>

export class AccountNotFound extends TaggedError('AccountNotFound')<{ id: string }> {}

// Stand-in for the application's authoritative repository.
@Plugin()
export class AccountSource extends BasePlugin {
	private readonly state = { loads: 0, failure: undefined as Error | undefined }
	private readonly accounts = new Map<string, Account>([['alice', { id: 'alice', name: 'Alice' }]])

	async find(id: string): Promise<Account | null> {
		this.state.loads++
		if (this.state.failure) throw this.state.failure
		return this.accounts.get(id) ?? null
	}
	loadCount(): number {
		return this.state.loads
	}
	put(account: Account): void {
		this.accounts.set(account.id, account)
	}
	setFailure(error?: Error): void {
		this.state.failure = error
	}
}

@Plugin()
export class CachedAccounts extends BasePlugin {
	private accounts!: CacheNamespace

	constructor(
		private readonly cache: Cache,
		private readonly source: AccountSource,
	) {
		super()
	}

	protected override init(): void {
		this.accounts = this.cache.scope('accounts', { ttlMs: 60_000 })
	}

	async find(id: string): Promise<Result<Account, AccountNotFound>> {
		// Only data and the deliberate negative-cache sentinel cross the backend.
		const account = await this.accounts.getOrLoad(id, () => this.source.find(id))
		return account === null ? Result.err(new AccountNotFound({ id })) : Result.ok(account)
	}

	invalidate(id: string): Promise<boolean> {
		return this.accounts.delete(id)
	}
}
