import {
	Decrypter,
	Encrypter,
	generateIdentity,
	identityToRecipient,
} from 'age-encryption'
import { type Context as PluxelContext, Injectable, RootService } from '@pluxel/core'
import { basename, resolve } from 'pathe'
import { env as stdEnv } from 'std-env'
import type { FsService } from '../fs/FsService'
import { recordSecurityEvent } from '../security/audit'
import {
	readSecurityIdentity,
	updateSecurityIdentity,
} from '../security/identity'
import type {
	VaultAdminState,
	VaultBlobHandle,
	VaultBlobsHandle,
	VaultCollectionHandle,
	VaultCollectionTransaction,
	VaultDocsHandle,
	VaultKeyPair,
	VaultKvHandle,
	VaultKvTransaction,
	VaultNamespace,
	VaultNamespaceTransaction,
	VaultNamespaceStats,
	VaultNamespaceOptions,
	VaultStorageApi,
	VaultServiceConfig,
	VaultStatusError,
	VaultUnlockSource,
} from './types'

const serviceName = 'vault' as const
const adminServiceName = 'vaultAdmin' as const

declare module '@pluxel/core' {
	namespace Context {
		interface Config {
			[serviceName]?: VaultServiceConfig
		}
		interface Services {
			[serviceName]: VaultStorageApi
		}
		interface RootServices {
			[adminServiceName]: VaultAdminService
		}
	}
}

export class VaultError extends Error {
	public readonly code:
		| 'ACCESS_DENIED'
		| 'DECRYPT_FAILED'
		| 'INVALID_CONFIG'
		| 'INVALID_FORMAT'
		| 'IO'
		| 'MISSING_MOUNT'
		| 'MISSING_IDENTITY'

	constructor(code: VaultError['code'], message: string, options?: { cause?: unknown }) {
		super(message)
		this.name = 'VaultError'
		this.code = code
		if (options?.cause !== undefined) (this as unknown as { cause?: unknown }).cause = options.cause
	}
}

type FsLike = Pick<
	FsService,
	'exists' | 'readText' | 'writeTextAtomic' | 'readBytes' | 'writeBytesAtomic' | 'unlink' | 'readdir'
>

type MountRuntime = {
	dir: string
	keysPath: string
	statePath: string
	blobsDir: string
	flushDebounceMs: number
	deployIdentityEnv: string
}

type VaultRuntimePhase = 'sealed' | 'unlocking' | 'ready' | 'blocked' | 'error'

type VaultRuntimeStatus = {
	phase: VaultRuntimePhase
	present: boolean
	dirty: boolean
	lastError?: VaultStatusError
}

type VaultProbeState = {
	unlockable: boolean
	reason?: VaultAdminState['reason']
	lastError?: VaultStatusError
}

type VaultSnapshot = {
	kind: 'pluxel.vault.snapshot'
	namespaces: Record<
		string,
		{
			kv: Record<string, unknown>
			docs: Record<string, Record<string, Record<string, unknown>>>
		}
	>
}

type MountCacheState =
	| { status: 'locked' }
	| {
			status: 'unlocked'
			dek: Uint8Array
			snapshot: VaultSnapshot
			unlockSource: VaultUnlockSource
			dirty: boolean
			timer: ReturnType<typeof setTimeout> | null
			flushPromise: Promise<void> | null
	  }

type ManagedVault = {
	kv: (options?: VaultNamespaceOptions) => VaultKvHandle
	docs: (options?: VaultNamespaceOptions) => VaultDocsHandle
	blobs: (options?: VaultNamespaceOptions) => VaultBlobsHandle
	namespace: (name?: string) => VaultNamespace
	flush: () => Promise<void>
	unlock: () => Promise<VaultAdminState>
	describe: () => Promise<VaultAdminState>
	rekey: () => Promise<void>
	ensureHostKey: () => Promise<string>
	sealForRuntime: () => Promise<void>
	setDeployRecipients: (recipients: string[]) => Promise<VaultAdminState>
	preflight: () => Promise<VaultAdminState>
}

type MountCacheEntry = {
	lock: AsyncLock
	state: MountCacheState
	status: {
		phase: VaultRuntimePhase
		dirty: boolean
		lastError?: VaultStatusError
	}
}

function isUnlockedState(
	state: MountCacheState,
): state is Extract<MountCacheState, { status: 'unlocked' }> {
	return state.status === 'unlocked'
}

class AsyncLock {
	private tail: Promise<void> = Promise.resolve()

	async run<T>(fn: () => Promise<T>): Promise<T> {
		const prev = this.tail
		let release!: () => void
		this.tail = new Promise<void>((done) => (release = done))
		await prev
		try {
			return await fn()
		} finally {
			release()
		}
	}
}

const CACHE_SYMBOL = Symbol.for('pluxel:vault:mount-cache')
const STATE_MAGIC = textEncode('PVLT2')
const NONCE_BYTES = 12
const DEFAULT_DIR = 'data/vault'
const SHARED_MOUNT = 'global'
const DEFAULT_FLUSH_DEBOUNCE_MS = 50
const DEFAULT_DEPLOY_IDENTITY_ENV = 'PLUXEL_VAULT_DEPLOY_IDENTITY'

function cloneStatusError(error?: VaultStatusError): VaultStatusError | undefined {
	return error ? { ...error } : undefined
}

function sameStatusState(
	left: MountCacheEntry['status'],
	right: MountCacheEntry['status'],
): boolean {
	return (
		left.phase === right.phase &&
		left.dirty === right.dirty &&
		left.lastError?.code === right.lastError?.code &&
		left.lastError?.message === right.lastError?.message
	)
}

function textEncode(input: string): Uint8Array {
	return new TextEncoder().encode(input)
}

function textDecode(input: Uint8Array): string {
	return new TextDecoder().decode(input)
}

function normalizeSegment(input: string): string {
	const trimmed = input || 'default'
	return basename(trimmed).replaceAll(/[^A-Za-z0-9._-]/g, '_')
}

function cloneJson<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T
}

function getWebCrypto(): Crypto {
	const cryptoRef = (globalThis as unknown as { crypto?: Crypto }).crypto
	if (!cryptoRef?.subtle || !cryptoRef.getRandomValues) {
		throw new VaultError('INVALID_CONFIG', 'WebCrypto is required by VaultService.')
	}
	return cryptoRef
}

function randomBytes(size: number): Uint8Array {
	const out = new Uint8Array(size)
	getWebCrypto().getRandomValues(out)
	return out
}

function toCryptoBuffer(bytes: Uint8Array): BufferSource {
	return bytes as unknown as BufferSource
}

async function aesEncrypt(keyBytes: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array> {
	const cryptoRef = getWebCrypto()
	const key = await cryptoRef.subtle.importKey(
		'raw',
		toCryptoBuffer(keyBytes),
		'AES-GCM',
		false,
		['encrypt'],
	)
	const nonce = randomBytes(NONCE_BYTES)
	const ciphertext = new Uint8Array(
		await cryptoRef.subtle.encrypt(
			{ name: 'AES-GCM', iv: toCryptoBuffer(nonce) },
			key,
			toCryptoBuffer(plaintext),
		),
	)
	const out = new Uint8Array(STATE_MAGIC.length + nonce.length + ciphertext.length)
	out.set(STATE_MAGIC, 0)
	out.set(nonce, STATE_MAGIC.length)
	out.set(ciphertext, STATE_MAGIC.length + nonce.length)
	return out
}

async function aesDecrypt(keyBytes: Uint8Array, input: Uint8Array): Promise<Uint8Array> {
	if (input.length < STATE_MAGIC.length + NONCE_BYTES + 16) {
		throw new VaultError('INVALID_FORMAT', 'Vault payload is too short.')
	}
	const magic = input.subarray(0, STATE_MAGIC.length)
	if (textDecode(magic) !== textDecode(STATE_MAGIC)) {
		throw new VaultError('INVALID_FORMAT', 'Unsupported vault payload format.')
	}
	const nonce = input.subarray(STATE_MAGIC.length, STATE_MAGIC.length + NONCE_BYTES)
	const ciphertext = input.subarray(STATE_MAGIC.length + NONCE_BYTES)
	try {
		const cryptoRef = getWebCrypto()
		const key = await cryptoRef.subtle.importKey(
			'raw',
			toCryptoBuffer(keyBytes),
			'AES-GCM',
			false,
			['decrypt'],
		)
		return new Uint8Array(
			await cryptoRef.subtle.decrypt(
				{ name: 'AES-GCM', iv: toCryptoBuffer(nonce) },
				key,
				toCryptoBuffer(ciphertext),
			),
		)
	} catch (cause) {
		throw new VaultError('DECRYPT_FAILED', 'Failed to decrypt vault payload.', { cause })
	}
}

function createEmptySnapshot(): VaultSnapshot {
	return { kind: 'pluxel.vault.snapshot', namespaces: {} }
}

function parseSnapshot(bytes: Uint8Array): VaultSnapshot {
	let parsed: unknown
	try {
		parsed = JSON.parse(textDecode(bytes))
	} catch (cause) {
		throw new VaultError('INVALID_FORMAT', 'Invalid vault snapshot JSON.', { cause })
	}
	if (!parsed || typeof parsed !== 'object') {
		throw new VaultError('INVALID_FORMAT', 'Invalid vault snapshot payload.')
	}
	const candidate = parsed as Record<string, unknown>
	if (candidate.kind !== 'pluxel.vault.snapshot') {
		throw new VaultError('INVALID_FORMAT', 'Unsupported vault snapshot format.')
	}
	if (!candidate.namespaces || typeof candidate.namespaces !== 'object' || Array.isArray(candidate.namespaces)) {
		throw new VaultError('INVALID_FORMAT', 'Vault snapshot namespaces must be an object.')
	}
	return {
		kind: 'pluxel.vault.snapshot',
		namespaces: candidate.namespaces as VaultSnapshot['namespaces'],
	}
}

function serializeSnapshot(snapshot: VaultSnapshot): Uint8Array {
	return textEncode(JSON.stringify(snapshot))
}

function splitMaterialLines(raw: string): string[] {
	return raw
		.split(/\r?\n/g)
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !line.startsWith('#'))
}

function getConfig(ctx: PluxelContext): VaultServiceConfig {
	return ctx.config.vault ?? {}
}

function resolveRuntime(
	ctx: PluxelContext,
): MountRuntime {
	const cfg = getConfig(ctx)
	const dir = resolve(cfg.dir ?? DEFAULT_DIR, SHARED_MOUNT)
	return {
		dir,
		keysPath: resolve(dir, 'keys.age'),
		statePath: resolve(dir, 'state.enc'),
		blobsDir: resolve(dir, 'blobs'),
		flushDebounceMs: cfg.flushDebounceMs ?? DEFAULT_FLUSH_DEBOUNCE_MS,
		deployIdentityEnv: cfg.deployIdentityEnv?.trim() || DEFAULT_DEPLOY_IDENTITY_ENV,
	}
}

function normalizeRecipients(input: Iterable<string>): string[] {
	const seen = new Set<string>()
	const recipients: string[] = []
	for (const entry of input) {
		const recipient = entry.trim()
		if (!recipient || seen.has(recipient)) continue
		seen.add(recipient)
		recipients.push(recipient)
	}
	return recipients
}

async function readDeployRecipients(fs: FsLike): Promise<string[]> {
	const identity = await readSecurityIdentity(fs)
	return normalizeRecipients(identity.vault?.deployRecipients ?? [])
}

async function writeDeployRecipients(
	fs: FsLike,
	recipients: string[],
): Promise<void> {
	const nextRecipients = normalizeRecipients(recipients)
	await updateSecurityIdentity(fs, (current) => ({
		...current,
		vault: {
			...current.vault,
			deployRecipients: nextRecipients,
		},
	}))
}

async function hasDeployIdentity(runtime: MountRuntime): Promise<boolean> {
	return splitMaterialLines((stdEnv[runtime.deployIdentityEnv] as string | undefined) ?? '').length > 0
}

async function ensureIdentity(
	fs: FsLike,
	createIfMissing: boolean,
): Promise<string | undefined> {
	const identityDoc = await readSecurityIdentity(fs)
	const identity = identityDoc.vault?.hostIdentity
	if (identity) return identity

	if (!createIfMissing) return undefined
	const nextIdentity = await generateIdentity()
	try {
		await updateSecurityIdentity(fs, (current) => ({
			...current,
			vault: {
				...current.vault,
				hostIdentity: nextIdentity,
			},
		}))
	} catch (cause) {
		throw new VaultError('IO', 'Failed to write host security identity.', { cause })
	}
	return nextIdentity
}

async function hasHostIdentity(fs: FsLike): Promise<boolean> {
	const identity = await readSecurityIdentity(fs)
	return !!identity.vault?.hostIdentity
}

async function resolveManagedRecipients(
	fs: FsLike,
	runtime: MountRuntime,
	deployRecipientsOverride?: string[],
	options: { createHostIdentity?: boolean } = {},
): Promise<string[]> {
	const recipients: string[] = []
	const identity = await ensureIdentity(fs, options.createHostIdentity === true)
	if (identity) recipients.push(await identityToRecipient(identity))
	const deployRecipients =
		deployRecipientsOverride !== undefined
			? normalizeRecipients(deployRecipientsOverride)
			: await readDeployRecipients(fs)
	return recipients.concat(deployRecipients)
}

async function resolveManagedIdentities(
	fs: FsLike,
	runtime: MountRuntime,
	options: { includeDeployIdentity?: boolean } = {},
): Promise<string[]> {
	const identities: string[] = []
	const localIdentity = await ensureIdentity(fs, false)
	if (localIdentity) identities.push(localIdentity)
	if (options.includeDeployIdentity !== false) {
		identities.push(...splitMaterialLines((stdEnv[runtime.deployIdentityEnv] as string | undefined) ?? ''))
	}
	return identities
}

async function encryptDek(
	fs: FsLike,
	runtime: MountRuntime,
	dek: Uint8Array,
	deployRecipientsOverride?: string[],
	options: { createHostIdentity?: boolean } = {},
): Promise<Uint8Array> {
	const encrypter = new Encrypter()
	const recipients = await resolveManagedRecipients(fs, runtime, deployRecipientsOverride, options)
	if (recipients.length === 0) {
		throw new VaultError('INVALID_CONFIG', 'No age recipients resolved for vault encryption.')
	}
	for (const recipient of recipients) encrypter.addRecipient(recipient)

	try {
		return await encrypter.encrypt(dek)
	} catch (cause) {
		throw new VaultError('IO', 'Failed to encrypt vault key with age.', { cause })
	}
}

async function decryptDek(
	fs: FsLike,
	runtime: MountRuntime,
	ciphertext: Uint8Array,
	options: { includeDeployIdentity?: boolean } = {},
): Promise<Uint8Array> {
	const decrypter = new Decrypter()
	const identities = await resolveManagedIdentities(fs, runtime, options)
	if (identities.length === 0) {
		throw new VaultError('INVALID_CONFIG', 'No age identities resolved for vault decryption.')
	}
	for (const identity of identities) decrypter.addIdentity(identity)

	try {
		return await decrypter.decrypt(ciphertext)
	} catch (cause) {
		throw new VaultError('DECRYPT_FAILED', 'Failed to decrypt vault key.', { cause })
	}
}

function getMountCache(): Map<string, MountCacheEntry> {
	const g = globalThis as Record<symbol, unknown>
	const existing = g[CACHE_SYMBOL]
	if (existing instanceof Map) return existing as Map<string, MountCacheEntry>
	const created = new Map<string, MountCacheEntry>()
	g[CACHE_SYMBOL] = created
	return created
}

function getOrCreateMountCache(key: string): MountCacheEntry {
	const cache = getMountCache()
	const existing = cache.get(key)
	if (existing) return existing
	const created: MountCacheEntry = {
		lock: new AsyncLock(),
		state: { status: 'locked' },
		status: { phase: 'sealed', dirty: false },
	}
	cache.set(key, created)
	return created
}

function isMountPresent(fs: FsLike, runtime: MountRuntime): boolean {
	return fs.exists(runtime.keysPath) || fs.exists(runtime.statePath)
}

function toRuntimeStatus(fs: FsLike, runtime: MountRuntime, entry: MountCacheEntry): VaultRuntimeStatus {
	return {
		phase: entry.status.phase,
		present: isMountPresent(fs, runtime),
		dirty: entry.status.dirty,
		lastError: cloneStatusError(entry.status.lastError),
	}
}

function updateStatus(
	fs: FsLike,
	runtime: MountRuntime,
	entry: MountCacheEntry,
	patch: Partial<MountCacheEntry['status']>,
): void {
	const next: MountCacheEntry['status'] = {
		phase: patch.phase ?? entry.status.phase,
		dirty: patch.dirty ?? entry.status.dirty,
		lastError:
			patch.lastError !== undefined ? cloneStatusError(patch.lastError) : cloneStatusError(entry.status.lastError),
	}
	if (sameStatusState(entry.status, next)) return
	entry.status = next
}

function clearStatusError(fs: FsLike, runtime: MountRuntime, entry: MountCacheEntry): void {
	if (!entry.status.lastError) return
	updateStatus(fs, runtime, entry, { lastError: undefined })
}

function toStatusError(error: unknown): VaultStatusError {
	return error instanceof VaultError
		? { code: error.code, message: error.message }
		: error instanceof Error
			? { code: 'IO', message: error.message }
			: { code: 'IO', message: String(error) }
}

function toFailurePhase(error: unknown): VaultRuntimePhase {
	return error instanceof VaultError && error.code === 'ACCESS_DENIED' ? 'blocked' : 'error'
}

function setStatusFailure(
	fs: FsLike,
	runtime: MountRuntime,
	entry: MountCacheEntry,
	error: unknown,
): void {
	updateStatus(fs, runtime, entry, {
		phase: toFailurePhase(error),
		dirty: false,
		lastError: toStatusError(error),
	})
}

function namespaceFrom(ctx: PluxelContext, options?: VaultNamespaceOptions): string {
	return normalizeSegment(options?.namespace ?? ctx.pluginInfo?.id ?? 'default')
}

function findNamespaceState(snapshot: VaultSnapshot, namespace: string) {
	return snapshot.namespaces[namespace]
}

async function loadMountState(
	fs: FsLike,
	runtime: MountRuntime,
	options: { includeDeployIdentity?: boolean } = {},
): Promise<{ dek: Uint8Array; snapshot: VaultSnapshot } | undefined> {
	if (!fs.exists(runtime.keysPath)) {
		if (fs.exists(runtime.statePath)) {
			throw new VaultError(
				'INVALID_FORMAT',
				`Vault mount is missing key envelope: ${runtime.keysPath}`,
			)
		}
		return undefined
	}

	const dek = await decryptDek(fs, runtime, await fs.readBytes(runtime.keysPath), options)
	if (!fs.exists(runtime.statePath)) return { dek, snapshot: createEmptySnapshot() }
	const plaintext = await aesDecrypt(dek, await fs.readBytes(runtime.statePath))
	return { dek, snapshot: parseSnapshot(plaintext) }
}

async function createMountKey(
	fs: FsLike,
	runtime: MountRuntime,
	deployRecipientsOverride?: string[],
	options: { createHostIdentity?: boolean } = {},
): Promise<Uint8Array> {
	const dek = randomBytes(32)
	await fs.writeBytesAtomic(
		runtime.keysPath,
		await encryptDek(fs, runtime, dek, deployRecipientsOverride, options),
	)
	return dek
}

async function createDeployKeyPair(ctx: PluxelContext): Promise<VaultKeyPair> {
	const runtime = resolveRuntime(ctx)
	const envName = runtime.deployIdentityEnv
	const privateKey = await generateIdentity()
	return {
		publicKey: await identityToRecipient(privateKey),
		privateKey,
		envName,
	}
}

async function flushUnlockedState(fs: FsLike, runtime: MountRuntime, state: Extract<MountCacheState, { status: 'unlocked' }>) {
	if (!state.dirty) return
	const ciphertext = await aesEncrypt(state.dek, serializeSnapshot(state.snapshot))
	await fs.writeBytesAtomic(runtime.statePath, ciphertext)
	state.dirty = false
}

function clearTimer(state: Extract<MountCacheState, { status: 'unlocked' }>) {
	if (state.timer) {
		clearTimeout(state.timer)
		state.timer = null
	}
}

function scheduleFlush(
	fs: FsLike,
	runtime: MountRuntime,
	entry: MountCacheEntry,
) {
	if (entry.state.status !== 'unlocked') return
	updateStatus(fs, runtime, entry, { phase: 'ready', dirty: true, lastError: undefined })
	clearTimer(entry.state)
	entry.state.timer = setTimeout(() => {
		void entry.lock.run(async () => {
			if (entry.state.status !== 'unlocked') return
			entry.state.flushPromise = flushUnlockedState(fs, runtime, entry.state)
				.then((): undefined => {
					updateStatus(fs, runtime, entry, { phase: 'ready', dirty: false, lastError: undefined })
					return undefined
				})
				.catch((error) => {
					setStatusFailure(fs, runtime, entry, error)
					throw error
				})
				.finally(() => {
					if (entry.state.status === 'unlocked') entry.state.flushPromise = null
				})
			await entry.state.flushPromise
		})
	}, runtime.flushDebounceMs)
}

function cloneNamespaceState(state?: VaultSnapshot['namespaces'][string]) {
	return cloneJson(state ?? { kv: {}, docs: {} })
}

function blobPath(runtime: MountRuntime, namespace: string, name: string): string {
	return resolve(runtime.blobsDir, namespace, `${normalizeSegment(name)}.blob`)
}

/**
 * Shared encrypted vault mount service.
 *
 * Design:
 * - one logical mount is a shared encrypted container
 * - `age` only wraps the mount DEK
 * - hot data (`kv` + `docs`) stays in memory and flushes to a symmetric snapshot
 * - blobs are separate symmetric files keyed by the same DEK
 */
@Injectable({ key: serviceName })
export class VaultService {
	constructor(public ctx: PluxelContext) {}

	managedVault(): ManagedVault {
		const ctx = this.ctx
		const fs: FsLike = ctx.root.fs
		const runtime = resolveRuntime(ctx)
		const entry = getOrCreateMountCache(runtime.dir)

		const currentStatus = () => toRuntimeStatus(fs, runtime, entry)

		const finalizeUnlockedState = (
			dek: Uint8Array,
			snapshot: VaultSnapshot,
			unlockSource: VaultUnlockSource = 'host',
			dirty = false,
		): Extract<MountCacheState, { status: 'unlocked' }> => {
			entry.state = {
				status: 'unlocked',
				dek,
				snapshot,
				unlockSource,
				dirty,
				timer: null,
				flushPromise: null,
			}
			updateStatus(fs, runtime, entry, {
				phase: 'ready',
				dirty,
				lastError: undefined,
			})
			return entry.state
		}

		const ensureUnlocked = async (
			options: {
				source?: VaultUnlockSource
				includeDeployIdentity?: boolean
			} = {},
		) => {
			if (entry.state.status === 'unlocked') return entry.state
			updateStatus(fs, runtime, entry, { phase: 'unlocking', dirty: false })
			const loaded = await loadMountState(fs, runtime, {
				includeDeployIdentity: options.includeDeployIdentity,
			})
			if (!loaded) {
				updateStatus(fs, runtime, entry, { phase: 'sealed', dirty: false, lastError: undefined })
				return undefined
			}
			return finalizeUnlockedState(loaded.dek, loaded.snapshot, options.source)
		}

		const resetAutoUnlockStatus = () => {
			updateStatus(fs, runtime, entry, {
				phase: 'sealed',
				dirty: false,
				lastError: undefined,
			})
		}

		const ensureAutoUnlocked = async () => {
			if (entry.state.status === 'unlocked' || !isMountPresent(fs, runtime)) return entry.state
			const deployIdentityPresent = await hasDeployIdentity(runtime)
			const hostIdentityPresent = await hasHostIdentity(fs)
			let lastError: unknown

			if (deployIdentityPresent) {
				try {
						const state = await ensureUnlocked({
							source: 'deploy',
							includeDeployIdentity: true,
						})
						if (state) {
							recordSecurityEvent(ctx, {
								area: 'vault',
								action: 'unlock',
								status: 'info',
								mount: SHARED_MOUNT,
								reason: 'deploy',
								message: `Vault mount "${SHARED_MOUNT}" auto-unlocked from deploy key.`,
							})
							return state
						}
				} catch (error) {
					lastError = error
					resetAutoUnlockStatus()
				}
			}

			if (hostIdentityPresent) {
				try {
					return await ensureUnlocked({
						source: 'host',
						includeDeployIdentity: false,
					})
				} catch (error) {
					lastError = error
					resetAutoUnlockStatus()
					throw error
				}
			}

			resetAutoUnlockStatus()
			if (lastError !== undefined) {
				throw lastError
			}
			return undefined
		}

		const mutateNamespace = async <T>(
			namespace: string,
			run: (
				nextNamespaceState: VaultSnapshot['namespaces'][string],
			) => Promise<{ result: T; changed: boolean }>,
		): Promise<T | undefined> => {
			return await entry.lock.run(async () => {
				try {
					await ensureAutoUnlocked()
					if (isUnlockedState(entry.state)) {
						const nextNamespaceState = cloneNamespaceState(entry.state.snapshot.namespaces[namespace])
						const { result, changed } = await run(nextNamespaceState)
						if (!changed) return result
						entry.state.snapshot.namespaces[namespace] = nextNamespaceState
						entry.state.dirty = true
						scheduleFlush(fs, runtime, entry)
						return result
					}

					const present = isMountPresent(fs, runtime)
					let loaded:
						| {
								dek: Uint8Array
								snapshot: VaultSnapshot
						  }
						| undefined
					if (present) {
						loaded = await loadMountState(fs, runtime, { includeDeployIdentity: true })
					}
					const nextSnapshot = loaded?.snapshot ?? createEmptySnapshot()
					const nextNamespaceState = cloneNamespaceState(nextSnapshot.namespaces[namespace])
					const { result, changed } = await run(nextNamespaceState)
					if (!changed) return result

					nextSnapshot.namespaces[namespace] = nextNamespaceState
					const dek = loaded?.dek ?? (await createMountKey(fs, runtime))
					finalizeUnlockedState(dek, nextSnapshot, 'host', true)
					scheduleFlush(fs, runtime, entry)
					return result
				} catch (error) {
					setStatusFailure(fs, runtime, entry, error)
					throw error
				}
			})
		}

		const readSnapshot = async <T>(run: (snapshot: VaultSnapshot) => T | Promise<T>): Promise<T> => {
			return await entry.lock.run(async () => {
				try {
					await ensureAutoUnlocked()
					if (isUnlockedState(entry.state)) {
						return await run(entry.state.snapshot)
					}
					if (!isMountPresent(fs, runtime)) {
						return await run(createEmptySnapshot())
					}
					const state = await ensureAutoUnlocked()
					const resolvedState = state ?? entry.state
					if (!isUnlockedState(resolvedState)) {
						throw new VaultError(
							'INVALID_CONFIG',
							`Vault mount "${SHARED_MOUNT}" requires an unlock identity.`,
						)
					}
					return await run(resolvedState.snapshot)
				} catch (error) {
					setStatusFailure(fs, runtime, entry, error)
					throw error
				}
			})
		}

		const readDek = async (createIfMissing: boolean) => {
			return await entry.lock.run(async () => {
				try {
					await ensureAutoUnlocked()
					if (isUnlockedState(entry.state)) return entry.state.dek
					const present = isMountPresent(fs, runtime)
					if (!present && !createIfMissing) {
						updateStatus(fs, runtime, entry, { phase: 'sealed', dirty: false, lastError: undefined })
						return undefined
					}
					updateStatus(fs, runtime, entry, { phase: 'unlocking', dirty: false })
					const loaded = await loadMountState(fs, runtime, { includeDeployIdentity: true })
					if (loaded) {
						finalizeUnlockedState(
							loaded.dek,
							loaded.snapshot,
							(await hasDeployIdentity(runtime)) ? 'deploy' : 'host',
						)
						return loaded.dek
					}
					if (!createIfMissing) return undefined
					const dek = await createMountKey(fs, runtime)
					finalizeUnlockedState(dek, createEmptySnapshot(), 'host')
					return dek
				} catch (error) {
					setStatusFailure(fs, runtime, entry, error)
					throw error
				}
			})
		}

		const flush = async () => {
			await entry.lock.run(async () => {
				if (entry.state.status !== 'unlocked') return
				clearTimer(entry.state)
				if (entry.state.flushPromise) await entry.state.flushPromise
				entry.state.flushPromise = flushUnlockedState(fs, runtime, entry.state)
					.then((): undefined => {
						updateStatus(fs, runtime, entry, { phase: 'ready', dirty: false, lastError: undefined })
						return undefined
					})
					.catch((error) => {
						setStatusFailure(fs, runtime, entry, error)
						throw error
					})
					.finally(() => {
						if (entry.state.status === 'unlocked') entry.state.flushPromise = null
					})
				await entry.state.flushPromise
			})
		}

		const sealForRuntime = async () => {
			await flush()
			entry.state = { status: 'locked' }
			updateStatus(fs, runtime, entry, { phase: 'sealed', dirty: false, lastError: undefined })
		}

		const rewriteEnvelope = async (deployRecipientsOverride?: string[]) => {
			if (!isUnlockedState(entry.state) && !isMountPresent(fs, runtime)) {
				throw new VaultError(
					'MISSING_MOUNT',
					`Vault mount "${SHARED_MOUNT}" does not exist and can not be rekeyed.`,
				)
			}
			let dek: Uint8Array | undefined
			if (isUnlockedState(entry.state)) {
				dek = entry.state.dek
			} else {
				const loaded = await loadMountState(fs, runtime, { includeDeployIdentity: true })
				dek = loaded?.dek ?? (await createMountKey(fs, runtime, deployRecipientsOverride))
				if (loaded) {
					finalizeUnlockedState(
						loaded.dek,
						loaded.snapshot,
						await hasDeployIdentity(runtime) ? 'deploy' : 'host',
					)
				}
			}
			if (!dek) throw new VaultError('INVALID_CONFIG', 'Failed to load vault key for rekey.')
			await fs.writeBytesAtomic(runtime.keysPath, await encryptDek(fs, runtime, dek, deployRecipientsOverride))
			clearStatusError(fs, runtime, entry)
		}

		const rekey = async () => {
			await entry.lock.run(async () => {
				try {
					await rewriteEnvelope()
					recordSecurityEvent(ctx, {
						area: 'vault',
						action: 'rekey',
						status: 'success',
						mount: SHARED_MOUNT,
						message: `Vault mount "${SHARED_MOUNT}" rekeyed successfully.`,
					})
				} catch (error) {
					recordSecurityEvent(ctx, {
						area: 'vault',
						action: 'rekey',
						status: 'failure',
						mount: SHARED_MOUNT,
						reason: error instanceof Error ? error.name : 'error',
						message:
							error instanceof Error
								? error.message
								: `Vault mount "${SHARED_MOUNT}" rekey failed.`,
					})
					setStatusFailure(fs, runtime, entry, error)
					throw error
				}
			})
		}

		const probeUnlockState = async (): Promise<VaultProbeState> => {
			const status = currentStatus()
			if (!status.present) return { unlockable: true, lastError: status.lastError }
			if (isUnlockedState(entry.state)) {
				return {
					unlockable: true,
					lastError: status.lastError,
				}
			}

			const hostIdentityPresent = await hasHostIdentity(fs)
			const deployIdentityPresent = await hasDeployIdentity(runtime)
			if (!hostIdentityPresent && !deployIdentityPresent) {
				return {
					unlockable: false,
					reason: 'unlock_required',
					lastError: status.lastError,
				}
			}

			try {
				await loadMountState(fs, runtime, { includeDeployIdentity: true })
				return {
					unlockable: true,
					lastError: status.lastError,
				}
			} catch (error) {
				return {
					unlockable: false,
					lastError: toStatusError(error),
				}
			}
		}

		const kv = (namespaceOptions?: VaultNamespaceOptions): VaultKvHandle => {
			const namespace = namespaceFrom(ctx, namespaceOptions)

			return {
				get: async <T>(key: string) =>
					await readSnapshot((snapshot) => findNamespaceState(snapshot, namespace)?.kv[key] as T | undefined),
				has: async (key: string) =>
					await readSnapshot((snapshot) => key in (findNamespaceState(snapshot, namespace)?.kv ?? {})),
				set: async (key: string, value: unknown) => {
					await mutateNamespace(namespace, async (namespaceState) => {
						namespaceState.kv[key] = value
						return { result: undefined, changed: true }
					})
				},
				setMany: async (entries) => {
					await mutateNamespace(namespace, async (namespaceState) => {
						const kvState = namespaceState.kv
						for (const [key, value] of Object.entries(entries)) kvState[key] = value
						return { result: undefined, changed: Object.keys(entries).length > 0 }
					})
				},
				delete: async (key: string) => {
					await mutateNamespace(namespace, async (namespaceState) => {
						const kvState = namespaceState.kv
						const changed = key in kvState
						delete kvState[key]
						return { result: undefined, changed }
					})
				},
				clear: async () => {
					await mutateNamespace(namespace, async (namespaceState) => {
						const kvState = namespaceState.kv
						const changed = Object.keys(kvState).length > 0
						namespaceState.kv = {}
						return { result: undefined, changed }
					})
				},
				keys: async () =>
					await readSnapshot((snapshot) => Object.keys(findNamespaceState(snapshot, namespace)?.kv ?? {}).sort()),
				entries: async <T = unknown>() =>
					await readSnapshot((snapshot) =>
						Object.entries(findNamespaceState(snapshot, namespace)?.kv ?? {}) as Array<[string, T]>,
					),
				batch: async <T>(run: (tx: VaultKvTransaction) => T | Promise<T>) => {
					const result = await mutateNamespace(namespace, async (namespaceState) => {
						const kvState = namespaceState.kv
						let changed = false
						const tx: VaultKvTransaction = {
							get: <U = unknown>(key: string) => kvState[key] as U | undefined,
							has: (key: string) => key in kvState,
							set: (key: string, value: unknown) => {
								changed = true
								kvState[key] = value
							},
							delete: (key: string) => {
								if (!(key in kvState)) return
								changed = true
								delete kvState[key]
							},
							clear: () => {
								if (Object.keys(kvState).length === 0) return
								changed = true
								for (const key of Object.keys(kvState)) delete kvState[key]
							},
							keys: () => Object.keys(kvState).sort(),
							entries: <U = unknown>() => Object.entries(kvState) as Array<[string, U]>,
						}
						return { result: await run(tx), changed }
					})
					return result as T
				},
			}
		}

		const docs = (namespaceOptions?: VaultNamespaceOptions): VaultDocsHandle => {
			const namespace = namespaceFrom(ctx, namespaceOptions)

			return {
				collection: <TDoc extends Record<string, unknown> = Record<string, unknown>>(
					collectionInput: string,
				): VaultCollectionHandle<TDoc> => {
					const collectionName = normalizeSegment(collectionInput)

					const docHandle = (id: string) => {
						const docId = normalizeSegment(id)
						return {
							get: async () =>
								await readSnapshot(
									(snapshot) =>
										findNamespaceState(snapshot, namespace)?.docs[collectionName]?.[docId] as TDoc | undefined,
								),
							set: async (value: TDoc) => {
								await mutateNamespace(namespace, async (namespaceState) => {
									namespaceState.docs[collectionName] ??= {}
									namespaceState.docs[collectionName][docId] = cloneJson(value)
									return { result: undefined, changed: true }
								})
							},
							patch: async (value: Partial<TDoc>) => {
								const result = await mutateNamespace(namespace, async (namespaceState) => {
									namespaceState.docs[collectionName] ??= {}
									const current = (namespaceState.docs[collectionName][docId] ?? {}) as TDoc
									const next = { ...current, ...cloneJson(value) } as TDoc
									namespaceState.docs[collectionName][docId] = next
									return { result: next, changed: true }
								})
								return result as TDoc
							},
							delete: async () => {
								await mutateNamespace(namespace, async (namespaceState) => {
									const docsState = namespaceState.docs[collectionName]
									const changed = !!docsState && docId in docsState
									delete docsState?.[docId]
									return { result: undefined, changed }
								})
							},
							exists: async () =>
								await readSnapshot(
									(snapshot) => docId in (findNamespaceState(snapshot, namespace)?.docs[collectionName] ?? {}),
								),
						}
					}

					return {
						doc: docHandle,
						get: async (id: string) => await docHandle(id).get(),
						set: async (id: string, value: TDoc) => await docHandle(id).set(value),
						patch: async (id: string, value: Partial<TDoc>) => await docHandle(id).patch(value),
						delete: async (id: string) => await docHandle(id).delete(),
						ids: async () =>
							await readSnapshot((snapshot) =>
								Object.keys(findNamespaceState(snapshot, namespace)?.docs[collectionName] ?? {}).sort(),
							),
						list: async () =>
							await readSnapshot((snapshot) => {
								const docsState = findNamespaceState(snapshot, namespace)?.docs[collectionName] ?? {}
								return Object.entries(docsState).map(([id, value]) => ({
									id,
									value: value as TDoc,
								}))
							}),
						clear: async () => {
							await mutateNamespace(namespace, async (namespaceState) => {
								const changed = !!namespaceState.docs[collectionName]
								delete namespaceState.docs[collectionName]
								return { result: undefined, changed }
							})
						},
					}
				},
			}
		}

		const blobs = (namespaceOptions?: VaultNamespaceOptions): VaultBlobsHandle => {
			const namespace = namespaceFrom(ctx, namespaceOptions)
			return {
				open: (name: string): VaultBlobHandle => {
					const path = blobPath(runtime, namespace, name)
					const readBytes = async () => {
						if (!fs.exists(path)) return undefined
						const dek = await readDek(false)
						if (!dek) return undefined
						return await aesDecrypt(dek, await fs.readBytes(path))
					}

					return {
						exists: async () => fs.exists(path),
						readBytes,
						readText: async () => {
							const bytes = await readBytes()
							return bytes ? textDecode(bytes) : undefined
						},
						writeBytes: async (bytes: Uint8Array) => {
							const dek = await readDek(true)
							if (!dek) throw new VaultError('INVALID_CONFIG', 'Failed to create vault key.')
							await fs.writeBytesAtomic(path, await aesEncrypt(dek, bytes))
						},
						writeText: async (text: string) => {
							await fs.writeBytesAtomic(path, await aesEncrypt((await readDek(true))!, textEncode(text)))
						},
						remove: async () => {
							if (!fs.exists(path)) return
							await fs.unlink(path)
						},
						describe: () => ({ path }),
					}
				},
				list: async () => {
					const namespaceDir = resolve(runtime.blobsDir, namespace)
					const names = await fs.readdir(namespaceDir)
					return names
						.filter((blobName) => blobName.endsWith('.blob'))
						.map((blobName) => blobName.slice(0, -'.blob'.length))
						.sort()
				},
			}
		}

			const namespaceHandle = (name?: string): VaultNamespace => {
			const resolvedNamespace = namespaceFrom(ctx, { namespace: name })
			const batch = async <T>(run: (tx: VaultNamespaceTransaction) => T | Promise<T>) => {
				const result = await mutateNamespace(resolvedNamespace, async (namespaceState) => {
					let changed = false
					const kvTx: VaultKvTransaction = {
						get: <U = unknown>(key: string) => namespaceState.kv[key] as U | undefined,
						has: (key: string) => key in namespaceState.kv,
						set: (key: string, value: unknown) => {
							changed = true
							namespaceState.kv[key] = value
						},
						delete: (key: string) => {
							if (!(key in namespaceState.kv)) return
							changed = true
							delete namespaceState.kv[key]
						},
						clear: () => {
							if (Object.keys(namespaceState.kv).length === 0) return
							changed = true
							namespaceState.kv = {}
						},
						keys: () => Object.keys(namespaceState.kv).sort(),
						entries: <U = unknown>() => Object.entries(namespaceState.kv) as Array<[string, U]>,
					}

					const docsTx = {
						collection: <TDoc extends Record<string, unknown> = Record<string, unknown>>(
							collectionNameInput: string,
						): VaultCollectionTransaction<TDoc> => {
							const collectionName = normalizeSegment(collectionNameInput)
							namespaceState.docs[collectionName] ??= {}
							const collectionState = namespaceState.docs[collectionName]!
							return {
								get: (id: string) => collectionState[normalizeSegment(id)] as TDoc | undefined,
								set: (id: string, value: TDoc) => {
									changed = true
									collectionState[normalizeSegment(id)] = cloneJson(value)
								},
								patch: (id: string, value: Partial<TDoc>) => {
									const docId = normalizeSegment(id)
									const current = (collectionState[docId] ?? {}) as TDoc
									const next = { ...current, ...cloneJson(value) } as TDoc
									changed = true
									collectionState[docId] = next
									return next
								},
								delete: (id: string) => {
									const docId = normalizeSegment(id)
									if (!(docId in collectionState)) return
									changed = true
									delete collectionState[docId]
								},
								ids: () => Object.keys(collectionState).sort(),
								list: () =>
									Object.entries(collectionState).map(([id, value]) => ({
										id,
										value: value as TDoc,
									})),
								clear: () => {
									if (Object.keys(collectionState).length === 0) return
									changed = true
									namespaceState.docs[collectionName] = {}
								},
							}
						},
					}

					return { result: await run({ kv: kvTx, docs: docsTx }), changed }
				})
				return result as T
			}
			return {
				name: resolvedNamespace,
				kv: () => kv({ namespace: resolvedNamespace }),
				docs: () => docs({ namespace: resolvedNamespace }),
				blobs: () => blobs({ namespace: resolvedNamespace }),
				batch,
			}
		}

		const describe = async (): Promise<VaultAdminState> => {
			const probe = await probeUnlockState()
			const unlocked = isUnlockedState(entry.state) ? entry.state : null
			const deployRecipients = await readDeployRecipients(fs)
			const current = currentStatus()
			let namespaces: VaultAdminState['namespaces'] | undefined
			if (unlocked) {
				const namespaceNames = new Set<string>(Object.keys(unlocked.snapshot.namespaces))
					for (const namespaceName of await fs.readdir(runtime.blobsDir).catch((): string[] => [])) {
						if (namespaceName) namespaceNames.add(namespaceName)
					}

					namespaces = []
					for (const namespaceName of [...namespaceNames].sort()) {
						const snapshotState = unlocked.snapshot.namespaces[namespaceName]
						const docsState = snapshotState?.docs ?? {}
						let docDocuments = 0
						for (const collection of Object.values(docsState)) {
							docDocuments += Object.keys(collection ?? {}).length
						}
						const blobNames = await fs
							.readdir(resolve(runtime.blobsDir, namespaceName))
							.catch((): string[] => [])
						const row: VaultNamespaceStats = {
							namespace: namespaceName,
							kvKeys: Object.keys(snapshotState?.kv ?? {}).length,
							docDocuments,
							blobs: blobNames.filter((name) => name.endsWith('.blob')).length,
						}
						namespaces.push(row)
					}
				}

			return {
				present: current.present,
				unlocked: unlocked !== null,
				reason: unlocked ? undefined : probe.reason,
				unlockedBy: unlocked?.unlockSource ?? null,
				lastError: probe.lastError ?? current.lastError,
				deploy: {
					env: runtime.deployIdentityEnv,
					identityPresent: await hasDeployIdentity(runtime),
					recipients: deployRecipients,
				},
				hostIdentityPresent: await hasHostIdentity(fs),
				namespaces,
			}
		}

		const preflight = async (): Promise<VaultAdminState> => {
			try {
				if (!isMountPresent(fs, runtime)) {
					updateStatus(fs, runtime, entry, {
						phase: 'sealed',
						dirty: false,
						lastError: undefined,
					})
					recordSecurityEvent(ctx, {
						area: 'vault',
						action: 'preflight',
						status: 'info',
						mount: SHARED_MOUNT,
						message: `Vault mount "${SHARED_MOUNT}" is absent; host startup continues without preload data.`,
					})
					return await describe()
				}

				await entry.lock.run(async () => {
					if (isUnlockedState(entry.state)) return
					const hostIdentityPresent = await hasHostIdentity(fs)
					const deployIdentityPresent = await hasDeployIdentity(runtime)
					if (!hostIdentityPresent && !deployIdentityPresent) {
						const error = new VaultError(
							'ACCESS_DENIED',
							`Vault mount "${SHARED_MOUNT}" is sealed and can not be unlocked during host startup.`,
						)
						setStatusFailure(fs, runtime, entry, error)
						throw error
					}
					try {
						const unlocked = await ensureAutoUnlocked()
						if (!isUnlockedState(unlocked ?? entry.state)) {
							throw new VaultError(
								'ACCESS_DENIED',
								`Vault mount "${SHARED_MOUNT}" is sealed and can not be unlocked during host startup.`,
							)
						}
						clearStatusError(fs, runtime, entry)
					} catch (error) {
						setStatusFailure(fs, runtime, entry, error)
						throw error
					}
				})

				recordSecurityEvent(ctx, {
					area: 'vault',
					action: 'preflight',
					status: 'success',
					mount: SHARED_MOUNT,
					message: `Vault mount "${SHARED_MOUNT}" is ready for host startup.`,
				})
				return await describe()
			} catch (error) {
				recordSecurityEvent(ctx, {
					area: 'vault',
					action: 'preflight',
					status: 'failure',
					mount: SHARED_MOUNT,
					reason: error instanceof Error ? error.name : 'error',
					message:
						error instanceof Error
							? error.message
							: `Vault mount "${SHARED_MOUNT}" failed host startup preflight.`,
				})
				throw error
			}
		}

		const unlock = async (): Promise<VaultAdminState> => {
			try {
				if (!isMountPresent(fs, runtime)) {
					recordSecurityEvent(ctx, {
						area: 'vault',
						action: 'unlock',
						status: 'info',
						mount: SHARED_MOUNT,
						message: `Vault mount "${SHARED_MOUNT}" is absent; nothing to unlock.`,
					})
					return await describe()
				}

				await entry.lock.run(async () => {
					if (isUnlockedState(entry.state)) return
					const hostIdentityPresent = await hasHostIdentity(fs)
					const deployIdentityPresent = await hasDeployIdentity(runtime)
					if (!hostIdentityPresent && !deployIdentityPresent) return
					try {
						await ensureAutoUnlocked()
						if (isUnlockedState(entry.state)) clearStatusError(fs, runtime, entry)
					} catch (error) {
						setStatusFailure(fs, runtime, entry, error)
						throw error
					}
				})

				const admin = await describe()
				recordSecurityEvent(ctx, {
					area: 'vault',
					action: 'unlock',
					status: admin.unlocked ? 'success' : 'info',
					mount: SHARED_MOUNT,
					reason: admin.reason,
					message: admin.unlocked
						? `Vault mount "${SHARED_MOUNT}" unlocked successfully.`
						: `Vault mount "${SHARED_MOUNT}" still requires matching unlock material.`,
				})
				return admin
			} catch (error) {
				recordSecurityEvent(ctx, {
					area: 'vault',
					action: 'unlock',
					status: 'failure',
					mount: SHARED_MOUNT,
					reason: error instanceof Error ? error.name : 'error',
					message:
						error instanceof Error
							? error.message
							: `Vault mount "${SHARED_MOUNT}" unlock failed.`,
				})
				throw error
			}
		}

		const vault: ManagedVault = {
			kv,
			docs,
			blobs,
				namespace: namespaceHandle,
			unlock,
			flush,
			rekey,
			preflight,
			sealForRuntime,
			setDeployRecipients: async (recipients: string[]) => {
				const nextRecipients = normalizeRecipients(recipients)
				if (isMountPresent(fs, runtime)) {
					await entry.lock.run(async () => {
						try {
							await rewriteEnvelope(nextRecipients)
						} catch (error) {
							setStatusFailure(fs, runtime, entry, error)
							throw error
						}
					})
				}
				await writeDeployRecipients(fs, nextRecipients)
				return await describe()
			},
			ensureHostKey: async () => {
				try {
					const identity = await ensureIdentity(fs, true)
					if (!identity) throw new VaultError('MISSING_IDENTITY', 'Missing local age identity.')
					clearStatusError(fs, runtime, entry)
					return await identityToRecipient(identity)
				} catch (error) {
					setStatusFailure(fs, runtime, entry, error)
					throw error
				}
			},
			describe,
		}
		return vault
	}

	kv(options?: VaultNamespaceOptions): VaultKvHandle {
		return this.managedVault().kv(options)
	}

	docs(options?: VaultNamespaceOptions): VaultDocsHandle {
		return this.managedVault().docs(options)
	}

	blobs(options?: VaultNamespaceOptions): VaultBlobsHandle {
		return this.managedVault().blobs(options)
	}

	namespace(name?: string): VaultNamespace {
		return this.managedVault().namespace(name)
	}

	flush(): Promise<void> {
		return this.managedVault().flush()
	}

	private async sealMountForTesting(): Promise<void> {
		await this.managedVault().sealForRuntime()
	}
}

@RootService({ key: adminServiceName })
export class VaultAdminService {
	constructor(public ctx: PluxelContext) {}

	private managedVault(): ManagedVault {
		return (this.ctx.root.vault as unknown as VaultService).managedVault()
	}

	preflight(): Promise<VaultAdminState> {
		return this.managedVault().preflight()
	}

	describe(): Promise<VaultAdminState> {
		return this.managedVault().describe()
	}

	unlock(): Promise<VaultAdminState> {
		return this.managedVault().unlock()
	}

	rekey(): Promise<void> {
		return this.managedVault().rekey()
	}

	ensureHostKey(): Promise<string> {
		return this.managedVault().ensureHostKey()
	}

	setDeployRecipients(recipients: string[]): Promise<VaultAdminState> {
		return this.managedVault().setDeployRecipients(recipients)
	}

	generateDeployKey(): Promise<VaultKeyPair> {
		return createDeployKeyPair(this.ctx)
	}
}
