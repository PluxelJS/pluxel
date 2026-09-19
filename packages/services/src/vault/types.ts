export type VaultServiceConfig = {
	/**
	 * Debounce window for snapshot flushes.
	 *
	 * @default 50
	 */
	flushDebounceMs?: number

	/**
	 * Environment variable that may contain an age private identity for deploy-time unlock.
	 *
	 * @default "PLUXEL_VAULT_DEPLOY_IDENTITY"
	 */
	deployIdentityEnv?: string
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
	docDocuments: number
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

export type VaultKvTransaction = {
	get: <T = unknown>(key: string) => T | undefined
	has: (key: string) => boolean
	set: (key: string, value: unknown) => void
	delete: (key: string) => void
	clear: () => void
	keys: () => string[]
	entries: <T = unknown>() => Array<[string, T]>
}

export type VaultKvHandle = {
	get: <T = unknown>(key: string) => Promise<T | undefined>
	has: (key: string) => Promise<boolean>
	set: (key: string, value: unknown) => Promise<void>
	setMany: (entries: Record<string, unknown>) => Promise<void>
	delete: (key: string) => Promise<void>
	clear: () => Promise<void>
	keys: () => Promise<string[]>
	entries: <T = unknown>() => Promise<Array<[string, T]>>
	batch: <T>(run: (tx: VaultKvTransaction) => T | Promise<T>) => Promise<T>
}

export type VaultDocHandle<TDoc extends Record<string, unknown> = Record<string, unknown>> = {
	get: () => Promise<TDoc | undefined>
	set: (value: TDoc) => Promise<void>
	patch: (value: Partial<TDoc>) => Promise<TDoc>
	delete: () => Promise<void>
	exists: () => Promise<boolean>
}

export type VaultCollectionHandle<TDoc extends Record<string, unknown> = Record<string, unknown>> =
	{
		doc: (id: string) => VaultDocHandle<TDoc>
		get: (id: string) => Promise<TDoc | undefined>
		set: (id: string, value: TDoc) => Promise<void>
		patch: (id: string, value: Partial<TDoc>) => Promise<TDoc>
		delete: (id: string) => Promise<void>
		ids: () => Promise<string[]>
		list: () => Promise<Array<{ id: string; value: TDoc }>>
		clear: () => Promise<void>
	}

export type VaultDocsHandle = {
	collection: <TDoc extends Record<string, unknown> = Record<string, unknown>>(
		name: string,
	) => VaultCollectionHandle<TDoc>
}

export type VaultCollectionTransaction<
	TDoc extends Record<string, unknown> = Record<string, unknown>,
> = {
	get: (id: string) => TDoc | undefined
	set: (id: string, value: TDoc) => void
	patch: (id: string, value: Partial<TDoc>) => TDoc
	delete: (id: string) => void
	ids: () => string[]
	list: () => Array<{ id: string; value: TDoc }>
	clear: () => void
}

export type VaultNamespaceTransaction = {
	kv: VaultKvTransaction
	docs: {
		collection: <TDoc extends Record<string, unknown> = Record<string, unknown>>(
			name: string,
		) => VaultCollectionTransaction<TDoc>
	}
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
	docs: () => VaultDocsHandle
	blobs: () => VaultBlobsHandle
	batch: <T>(run: (tx: VaultNamespaceTransaction) => T | Promise<T>) => Promise<T>
}

export type VaultStorageApi = {
	kv: (options?: VaultNamespaceOptions) => VaultKvHandle
	docs: (options?: VaultNamespaceOptions) => VaultDocsHandle
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
