/**
 * Vault (Portable Vault v1)
 *
 * Public types for the plugin-facing encrypted storage service.
 *
 * Notes:
 * - The Vault is optimized for runtime performance: decrypted payload is cached in-memory.
 * - Use `vault.batch()` to reduce encrypt+write frequency for large writes.
 * - To run without real filesystem IO (tests / ephemeral runs), set `ctx.config.fs.mode = "memory"`.
 */

export type VaultServiceConfig = {
	/**
	 * Base directory for all vault namespaces.
	 *
	 * Actual files are stored under:
	 * - `${dir}/${namespace}/vault.json`
	 * - `${dir}/${namespace}/vault.key` (when using keyfile slot)
	 *
	 * @default "data/vault"
	 */
	dir?: string

	/**
	 * Default AAD binding for encryption/decryption.
	 *
	 * AAD is used to prevent cross-namespace (or cross-context) ciphertext reuse.
	 * If runtime AAD differs from the stored AAD, decrypt is rejected with `AAD_MISMATCH`.
	 *
	 * - `false`: do not bind (AAD empty).
	 * - `true`: bind to `pluxel|plugin:${pluginId}` (recommended default).
	 * - `string`: bind to this literal string.
	 */
	defaultAad?: boolean | string

	/**
	 * Optional mapping for key material from env vars.
	 *
	 * If set, the vault will read key material from env instead of `vault.key`.
	 * The env value is interpreted as UTF-8 bytes by default.
	 */
	keyEnv?: Record<string, string> | string

	/**
	 * Optional mapping for passphrase from env vars.
	 *
	 * Only used when passphrase slots exist / are required by policy.
	 */
	passphraseEnv?: Record<string, string> | string
}

export type VaultPolicy = 'ANY' | 'REQUIRE_PASSPHRASE' | '2OF2'
export type VaultKdfAlg = 'scrypt' | 'argon2id'
export type VaultAeadAlg = 'aes-256-gcm' | 'xchacha20poly1305'

export type VaultOpenOptions = {
	/**
	 * Override which namespace this vault operates on.
	 *
	 * Default: the current plugin id (`ctx.pluginInfo.id`).
	 */
	namespace?: string

	/** Override base dir for this call (defaults to `ctx.config.vault.dir`). */
	dir?: string

	/**
	 * Override key material source (keyfile slot).
	 *
	 * - `{ bytes }`: use these bytes directly.
	 * - `{ env, encoding? }`: read from env and decode.
	 * - `{ keyfilePath }`: read/create keyfile at this path (init only creates).
	 */
	key?:
		| { env: string; encoding?: 'utf8' | 'base64' | 'hex' }
		| { bytes: Uint8Array }
		| { keyfilePath: string }

	/**
	 * Provide passphrase (passphrase slot).
	 *
	 * Notes:
	 * - If the vault is already unlocked in-memory for this process, passphrase won't be re-checked
	 *   until you call `vault.lock()` (performance design).
	 */
	passphrase?: string | { env: string }

	/**
	 * Override AAD binding for this call.
	 *
	 * - `undefined`: use default AAD (from config).
	 * - `null`: use empty AAD.
	 * - `string`: bind to these bytes (UTF-8).
	 */
	aadString?: string | null
}

export type VaultHandle = {
	/** Returns token value or `undefined` when missing. */
	getToken: (name: string) => Promise<string | undefined>
	/** Upserts a token. Creates the vault if missing. */
	setToken: (name: string, value: string) => Promise<void>
	/**
	 * Upserts multiple tokens in a single encrypt+write.
	 *
	 * Equivalent to calling `batch()` and `setToken()` repeatedly.
	 */
	setTokens: (tokens: Record<string, string>) => Promise<void>
	/** Deletes a token. */
	deleteToken: (name: string) => Promise<void>

	/** Reads an arbitrary JSON value from the vault. */
	getSecret: <T = unknown>(name: string) => Promise<T | undefined>
	/** Stores an arbitrary JSON value into the vault. */
	setSecret: (name: string, value: unknown) => Promise<void>
	/**
	 * Upserts multiple secrets in a single encrypt+write.
	 *
	 * Equivalent to calling `batch()` and `setSecret()` repeatedly.
	 */
	setSecrets: (secrets: Record<string, unknown>) => Promise<void>
	/** Deletes a secret value. */
	deleteSecret: (name: string) => Promise<void>

	/** Lists all keys (tokens + secrets), sorted. */
	listKeys: () => Promise<string[]>

	/**
	 * Adds a passphrase slot and optionally updates policy.
	 *
	 * - `keepAny`: policy = `ANY`
	 * - `requirePassphrase`: policy = `REQUIRE_PASSPHRASE`
	 * - `twoFactor`: policy = `2OF2`
	 */
	addPassphrase: (
		passphrase: string,
		mode?: 'keepAny' | 'requirePassphrase' | 'twoFactor',
	) => Promise<void>

	/**
	 * Batch multiple mutations into a single encrypt+write.
	 *
	 * This is the primary performance tool when writing many keys.
	 * If the callback throws, no changes are persisted.
	 *
	 * Notes:
	 * - If the vault does not exist yet and the callback makes no mutations, no files are created.
	 */
	batch: <T>(
		run: (tx: {
			getToken: (name: string) => string | undefined
			setToken: (name: string, value: string) => void
			deleteToken: (name: string) => void
			getSecret: <U = unknown>(name: string) => U | undefined
			setSecret: (name: string, value: unknown) => void
			deleteSecret: (name: string) => void
		}) => T | Promise<T>,
	) => Promise<T>

	/**
	 * Drops decrypted payload from memory (file remains).
	 *
	 * Useful to:
	 * - simulate a fresh unlock in tests;
	 * - reduce memory footprint;
	 * - force re-check of passphrase/material on next access.
	 */
	lock: () => void
}

// ---- Portable Vault v1 file format (advanced; used for debugging/tests) ----

export type VaultCipherRecord = {
	alg: VaultAeadAlg
	nonce: string
	aad?: string
	ct: string
}

export type VaultKeyfileSlotV1 = {
	type: 'keyfile'
	id: string
	hkdf: { salt: string; info: string }
	wrap: VaultCipherRecord
}

export type VaultPassphraseSlotV1 = {
	type: 'passphrase'
	id: string
	kdf:
		| { alg: 'argon2id'; m: number; t: number; p: number; salt: string }
		| { alg: 'scrypt'; N: number; r: number; p: number; salt: string }
	wrap: VaultCipherRecord
}

export type VaultSlotV1 = VaultKeyfileSlotV1 | VaultPassphraseSlotV1

export type VaultFileV1 = {
	v: 1
	policy: VaultPolicy
	createdAt: string
	updatedAt: string
	payload: VaultCipherRecord
	slots: VaultSlotV1[]
}

export type VaultPayloadV1 = {
	magic: 'PV1'
	tokens: Record<string, string>
	secrets?: Record<string, unknown>
	meta?: Record<string, unknown>
}

