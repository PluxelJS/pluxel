import type { PluginNodeAddress } from '@pluxel/core'

export type VaultServiceConfig = {
	/** Encrypted persistent KV by default; bindings installs read-only records without storage or keys. */
	backend?: 'encrypted' | 'bindings'
	/** Explicit age private identity supplied by the application startup factory. */
	deployIdentity?: string
	/** Explicitly assign legacy global namespaces to an owner. Migration is persisted once and keeps the source data. */
	legacyNamespaces?: readonly Readonly<{
		owner: PluginNodeAddress
		namespace: string
		from: string
	}>[]
}

export type VaultNamespaceOptions = {
	namespace?: string
}

export type VaultStatusError = {
	code: string
	message: string
}

export type VaultUnlockSource = 'host' | 'deploy'

export type VaultAccessReason = 'unlock_required'
export type VaultNamespaceStats = {
	namespace: string
	kvKeys: number
	blobs: number
}

export type VaultAdminState = {
	present: boolean
	unlocked: boolean
	reason?: VaultAccessReason
	unlockedBy: VaultUnlockSource | null
	lastError?: VaultStatusError
	deploy: {
		env: string
		identityPresent: boolean
		recipients: string[]
	}
	hostIdentityPresent: boolean
	namespaces?: VaultNamespaceStats[]
}

export type VaultKeyPair = {
	publicKey: string
	privateKey: string
	envName: string
}

export type VaultRecordSnapshot<T = unknown> = Readonly<{
	key: string
	exists: boolean
	value: T | undefined
	revision: number
	source: 'kv' | 'env' | 'file'
	writable: boolean
}>
export type VaultWriteOptions = Readonly<{ expectedRevision?: number }>
export type VaultListOptions = Readonly<{ prefix?: string; after?: string; limit?: number }>
export type VaultSubscription<T = unknown> = Readonly<{
	snapshot: VaultRecordSnapshot<T>
	dispose(): void
}>
export type VaultPrefixSubscription<T = unknown> = Readonly<{
	/** Atomic initial prefix snapshot. Prefixes larger than 1000 records are rejected. */
	snapshots: readonly VaultRecordSnapshot<T>[]
	dispose(): void
}>
export type VaultKvTransaction = {
	get<T = unknown>(key: string): VaultRecordSnapshot<T>
	set(key: string, value: unknown, options?: VaultWriteOptions): VaultRecordSnapshot
	delete(key: string, options?: VaultWriteOptions): VaultRecordSnapshot
	keys(options?: VaultListOptions): readonly string[]
}
export type VaultKvHandle = {
	get<T = unknown>(key: string): Promise<VaultRecordSnapshot<T>>
	set(key: string, value: unknown, options?: VaultWriteOptions): Promise<VaultRecordSnapshot>
	delete(key: string, options?: VaultWriteOptions): Promise<VaultRecordSnapshot>
	keys(options?: VaultListOptions): Promise<readonly string[]>
	batch<T>(run: (tx: VaultKvTransaction) => T | Promise<T>): Promise<T>
	watchPrefix<T = unknown>(
		prefix: string,
		listener: (snapshot: VaultRecordSnapshot<T>) => void | Promise<void>,
	): Promise<VaultPrefixSubscription<T>>
	watch<T = unknown>(
		key: string,
		listener: (snapshot: VaultRecordSnapshot<T>) => void | Promise<void>,
	): Promise<VaultSubscription<T>>
}

export type VaultBlobHandle = {
	exists: () => Promise<boolean>
	readBytes: () => Promise<Uint8Array | undefined>
	readText: () => Promise<string | undefined>
	writeBytes: (bytes: Uint8Array) => Promise<void>
	writeText: (text: string) => Promise<void>
	remove: () => Promise<void>
	describe: () => { path: string }
}

export type VaultBlobsHandle = {
	open: (name: string) => VaultBlobHandle
	list: () => Promise<string[]>
}

export type VaultNamespace = {
	name: string
	kv: () => VaultKvHandle
	blobs: () => VaultBlobsHandle
}

export type VaultStorageApi = {
	kv: (options?: VaultNamespaceOptions) => VaultKvHandle
	blobs: (options?: VaultNamespaceOptions) => VaultBlobsHandle
	namespace: (name?: string) => VaultNamespace
	flush: () => Promise<void>
}

export type VaultAdminApi = {
	preflight: () => Promise<VaultAdminState>
	describe: () => Promise<VaultAdminState>
	unlock: () => Promise<VaultAdminState>
	rekey: () => Promise<void>
	ensureHostKey: () => Promise<string>
	setDeployRecipients: (recipients: string[]) => Promise<VaultAdminState>
	generateDeployKey: () => Promise<VaultKeyPair>
}
