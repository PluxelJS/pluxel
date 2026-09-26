import { Decrypter, Encrypter, generateIdentity, identityToRecipient } from 'age-encryption'
import type { HostVaultBindingRecord } from '@pluxel/host/bindings'
import type { Context as PluxelContext } from '@pluxel/core'
import { enterOwnerInvocation } from '@pluxel/core/host'
import { pinOwnerContext } from '../internal/owner-view'
import { basename, join } from 'pathe'
import type { PersistenceNamespace } from '../persistence/service'
import { pluginNodePhysicalKey } from '../internal/plugin-address'
import { recordSecurityEvent } from '../internal/security'
import type {
	VaultAdminState,
	VaultBlobHandle,
	VaultBlobsHandle,
	VaultKeyPair,
	VaultRecordSnapshot,
	VaultWriteOptions,
	VaultListOptions,
	VaultKvHandle,
	VaultKvTransaction,
	VaultNamespace,
	VaultNamespaceStats,
	VaultNamespaceOptions,
	VaultServiceConfig,
	VaultStatusError,
	VaultUnlockSource,
} from './types'

/** Keep the complete operation admitted through owner stop and Host resource shutdown. */
async function runVaultOperation<T>(ctx: PluxelContext, run: () => Promise<T>): Promise<T> {
	const rootLease = enterOwnerInvocation(ctx.root)
	try {
		const ownerLease = ctx === ctx.root ? undefined : enterOwnerInvocation(ctx)
		try {
			return await run()
		} finally {
			ownerLease?.dispose()
		}
	} finally {
		rootLease.dispose()
	}
}

export { VaultError } from './error'
import { VaultError } from './error'

type VaultStore = {
	exists(key: string): Promise<boolean>
	readText(key: string): Promise<string | undefined>
	writeText(key: string, text: string): Promise<void>
	readBytes(key: string): Promise<Uint8Array | undefined>
	writeBytes(key: string, bytes: Uint8Array): Promise<void>
	delete(key: string): Promise<void>
	listChildren(prefix: string): Promise<string[]>
}

type MountRuntime = {
	dir: string
	keysPath: string
	statePath: string
	blobsDir: string
	backend: 'encrypted' | 'bindings'
	deployIdentity: string
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

type SecurityIdentityDoc = {
	version: 1
	vault?: {
		hostIdentity?: string
		deployRecipients?: string[]
	}
}

type VaultSnapshot = {
	kind: 'pluxel.vault.snapshot'
	version: 2
	namespaces: Record<
		string,
		{
			kv: Record<string, unknown>
			revisions: Record<string, number>
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
	overlays: Map<string, Map<string, VaultRecordSnapshot>>
	watchers: Map<
		string,
		Set<{ key: string; prefix?: boolean; notify(snapshot: VaultRecordSnapshot): void }>
	>
	state: MountCacheState
	status: {
		phase: VaultRuntimePhase
		dirty: boolean
		lastError?: VaultStatusError
	}
}

type VaultRootBacking = Readonly<{
	store: VaultStore
	runtime: MountRuntime
	entry: MountCacheEntry
}>

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

const STATE_MAGIC = textEncode('PVLT2')
const NONCE_BYTES = 12
const SHARED_MOUNT = 'global'
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

function normalizeStoreKey(key: string): string {
	return String(key || '')
		.replaceAll('\\', '/')
		.replace(/^\/+/, '')
}

function createVaultStore(storage: PersistenceNamespace): VaultStore {
	return {
		exists: async (key) => (await storage.stat(key)) !== undefined,
		readText: (key) => storage.getText(key),
		writeText: (key, text) => storage.put(key, text, { atomic: true }),
		readBytes: (key) => storage.get(key),
		writeBytes: (key, bytes) => storage.put(key, bytes, { atomic: true }),
		delete: (key) => storage.delete(key),
		listChildren: async (prefix) => {
			const cleanPrefix = normalizeStoreKey(prefix)
			const childNames = new Set<string>()
			for await (const entry of storage.list(prefix)) {
				let key = normalizeStoreKey(entry.key)
				if (cleanPrefix && key.startsWith(`${cleanPrefix}/`)) {
					key = key.slice(cleanPrefix.length + 1)
				}
				const child = key.split('/').find(Boolean)
				if (child) childNames.add(child)
			}
			return [...childNames].sort()
		},
	}
}

function cloneJson<T>(value: T): T {
	const seen = new Set<object>()
	const copy = (input: unknown): unknown => {
		if (input === null || typeof input === 'string' || typeof input === 'boolean') return input
		if (typeof input === 'number' && Number.isFinite(input)) return input
		if (!input || typeof input !== 'object' || seen.has(input))
			throw new VaultError('INVALID_FORMAT', 'Vault values must be finite acyclic JSON data.')
		const prototype = Object.getPrototypeOf(input)
		if (
			Object.getOwnPropertySymbols(input).length > 0 ||
			(Array.isArray(input) && Object.keys(input).length !== input.length)
		)
			throw new VaultError(
				'INVALID_FORMAT',
				'Vault values cannot contain symbols or sparse arrays.',
			)
		if (!Array.isArray(input) && prototype !== Object.prototype && prototype !== null)
			throw new VaultError('INVALID_FORMAT', 'Vault values must be plain JSON data.')
		seen.add(input)
		try {
			const output: Record<string, unknown> | unknown[] = Array.isArray(input)
				? []
				: Object.create(null)
			for (const key of Object.keys(input)) {
				const descriptor = Object.getOwnPropertyDescriptor(input, key)!
				if (!('value' in descriptor))
					throw new VaultError('INVALID_FORMAT', 'Vault values cannot contain accessors.')
				Object.defineProperty(output, key, {
					value: copy(descriptor.value),
					enumerable: true,
					writable: true,
					configurable: true,
				})
			}
			return output
		} finally {
			seen.delete(input)
		}
	}
	return copy(value) as T
}
function freezeJson<T>(input: T): T {
	if (input && typeof input === 'object') {
		for (const child of Object.values(input)) freezeJson(child)
		Object.freeze(input)
	}
	return input
}
function validateKey(key: string): void {
	if (
		typeof key !== 'string' ||
		key.length === 0 ||
		key.length > 512 ||
		[...key].some((character) => character.charCodeAt(0) < 32) ||
		['__proto__', 'prototype', 'constructor'].includes(key)
	)
		throw new VaultError('INVALID_CONFIG', 'Invalid Vault record key.')
}
function recordSnapshot(
	state: VaultSnapshot['namespaces'][string] | undefined,
	key: string,
	writable: boolean,
): VaultRecordSnapshot {
	const exists = !!state && Object.hasOwn(state.kv, key)
	return Object.freeze({
		key,
		exists,
		value: exists ? freezeJson(cloneJson(state!.kv[key])) : undefined,
		revision: state?.revisions[key] ?? 0,
		source: 'kv',
		writable,
	})
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
	const key = await cryptoRef.subtle.importKey('raw', toCryptoBuffer(keyBytes), 'AES-GCM', false, [
		'encrypt',
	])
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
	return { kind: 'pluxel.vault.snapshot', version: 2, namespaces: {} }
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
	if (
		!candidate.namespaces ||
		typeof candidate.namespaces !== 'object' ||
		Array.isArray(candidate.namespaces)
	) {
		throw new VaultError('INVALID_FORMAT', 'Vault snapshot namespaces must be an object.')
	}
	if (candidate.version !== 2)
		throw new VaultError('INVALID_FORMAT', 'Unsupported vault snapshot version.')
	const namespaces: VaultSnapshot['namespaces'] = Object.create(null)
	for (const [name, input] of Object.entries(candidate.namespaces)) {
		if (!input || typeof input !== 'object' || Array.isArray(input))
			throw new VaultError('INVALID_FORMAT', 'Invalid vault namespace.')
		const raw = input as Record<string, unknown>
		if (!raw.kv || typeof raw.kv !== 'object' || Array.isArray(raw.kv))
			throw new VaultError('INVALID_FORMAT', 'Invalid vault records.')
		const kv = cloneJson(raw.kv) as Record<string, unknown>
		const revisions: Record<string, number> = Object.create(null)
		if (!raw.revisions || typeof raw.revisions !== 'object' || Array.isArray(raw.revisions))
			throw new VaultError('INVALID_FORMAT', 'Invalid vault revisions.')
		for (const [key, revision] of Object.entries(raw.revisions)) {
			if (!Number.isSafeInteger(revision) || (revision as number) < 1)
				throw new VaultError('INVALID_FORMAT', 'Invalid vault revision.')
			revisions[key] = revision as number
		}
		for (const key of Object.keys(kv))
			if (!revisions[key]) throw new VaultError('INVALID_FORMAT', 'Missing vault revision.')

		namespaces[name] = { kv, revisions }
	}
	return { kind: 'pluxel.vault.snapshot', version: 2, namespaces }
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

function resolveRuntime(config: VaultServiceConfig = {}): MountRuntime {
	const dir = SHARED_MOUNT
	return {
		dir,
		keysPath: join(dir, 'keys.age'),
		statePath: join(dir, 'state.enc'),
		blobsDir: join(dir, 'blobs'),
		backend: config.backend ?? 'encrypted',
		deployIdentity: config.deployIdentity ?? '',
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

const SECURITY_IDENTITY_KEY = 'security/identity.json'

function emptySecurityIdentityDoc(): SecurityIdentityDoc {
	return { version: 1 }
}

function trimOrUndefined(value: unknown): string | undefined {
	if (typeof value !== 'string') return undefined
	const trimmed = value.trim()
	return trimmed || undefined
}

function normalizeDeployRecipientsValue(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined
	const recipients = normalizeRecipients(
		value.filter((entry): entry is string => typeof entry === 'string'),
	)
	return recipients.length > 0 ? recipients : undefined
}

function normalizeSecurityIdentity(input: unknown): SecurityIdentityDoc {
	if (!input || typeof input !== 'object') return emptySecurityIdentityDoc()
	const source = input as {
		vault?: { hostIdentity?: unknown; deployRecipients?: unknown }
	}
	const hostIdentity = trimOrUndefined(source.vault?.hostIdentity)
	const deployRecipients = normalizeDeployRecipientsValue(source.vault?.deployRecipients)
	const doc: SecurityIdentityDoc = { version: 1 }
	if (hostIdentity || deployRecipients) {
		doc.vault = {}
		if (hostIdentity) doc.vault.hostIdentity = hostIdentity
		if (deployRecipients) doc.vault.deployRecipients = deployRecipients
	}
	return doc
}

function securityIdentityHasMaterial(doc: SecurityIdentityDoc): boolean {
	return !!(
		doc.vault?.hostIdentity ||
		(doc.vault?.deployRecipients && doc.vault.deployRecipients.length > 0)
	)
}

async function readSecurityIdentity(store: VaultStore): Promise<SecurityIdentityDoc> {
	const raw = await store.readText(SECURITY_IDENTITY_KEY)
	if (raw === undefined) return emptySecurityIdentityDoc()
	return normalizeSecurityIdentity(JSON.parse(raw) as unknown)
}

async function writeSecurityIdentity(store: VaultStore, doc: SecurityIdentityDoc): Promise<void> {
	const normalized = normalizeSecurityIdentity(doc)
	if (!securityIdentityHasMaterial(normalized)) {
		await store.delete(SECURITY_IDENTITY_KEY)
		return
	}
	await store.writeText(SECURITY_IDENTITY_KEY, `${JSON.stringify(normalized, null, 2)}\n`)
}

async function updateSecurityIdentity(
	store: VaultStore,
	update: (current: SecurityIdentityDoc) => SecurityIdentityDoc,
): Promise<SecurityIdentityDoc> {
	const next = normalizeSecurityIdentity(update(await readSecurityIdentity(store)))
	await writeSecurityIdentity(store, next)
	return next
}

async function readDeployRecipients(store: VaultStore): Promise<string[]> {
	const identity = await readSecurityIdentity(store)
	return normalizeRecipients(identity.vault?.deployRecipients ?? [])
}

async function writeDeployRecipients(store: VaultStore, recipients: string[]): Promise<void> {
	const nextRecipients = normalizeRecipients(recipients)
	await updateSecurityIdentity(store, (current) => ({
		...current,
		vault: {
			...current.vault,
			deployRecipients: nextRecipients,
		},
	}))
}

async function hasDeployIdentity(runtime: MountRuntime): Promise<boolean> {
	return splitMaterialLines(runtime.deployIdentity).length > 0
}

async function ensureIdentity(
	store: VaultStore,
	createIfMissing: boolean,
): Promise<string | undefined> {
	const identityDoc = await readSecurityIdentity(store)
	const identity = identityDoc.vault?.hostIdentity
	if (identity) return identity

	if (!createIfMissing) return undefined
	const nextIdentity = await generateIdentity()
	try {
		await updateSecurityIdentity(store, (current) => ({
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

async function hasHostIdentity(store: VaultStore): Promise<boolean> {
	const identity = await readSecurityIdentity(store)
	return !!identity.vault?.hostIdentity
}

async function resolveManagedRecipients(
	store: VaultStore,
	_runtime: MountRuntime,
	deployRecipientsOverride?: string[],
	options: { createHostIdentity?: boolean } = {},
): Promise<string[]> {
	const recipients: string[] = []
	const identity = await ensureIdentity(store, options.createHostIdentity === true)
	if (identity) recipients.push(await identityToRecipient(identity))
	const deployRecipients =
		deployRecipientsOverride !== undefined
			? normalizeRecipients(deployRecipientsOverride)
			: await readDeployRecipients(store)
	return recipients.concat(deployRecipients)
}

async function resolveManagedIdentities(
	store: VaultStore,
	runtime: MountRuntime,
	options: { includeDeployIdentity?: boolean } = {},
): Promise<string[]> {
	const identities: string[] = []
	const localIdentity = await ensureIdentity(store, false)
	if (localIdentity) identities.push(localIdentity)
	if (options.includeDeployIdentity !== false) {
		identities.push(...splitMaterialLines(runtime.deployIdentity))
	}
	return identities
}

async function encryptDek(
	store: VaultStore,
	runtime: MountRuntime,
	dek: Uint8Array,
	deployRecipientsOverride?: string[],
	options: { createHostIdentity?: boolean } = {},
): Promise<Uint8Array> {
	const encrypter = new Encrypter()
	const recipients = await resolveManagedRecipients(
		store,
		runtime,
		deployRecipientsOverride,
		options,
	)
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
	store: VaultStore,
	runtime: MountRuntime,
	ciphertext: Uint8Array,
	options: { includeDeployIdentity?: boolean } = {},
): Promise<Uint8Array> {
	const decrypter = new Decrypter()
	const identities = await resolveManagedIdentities(store, runtime, options)
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

function createMountCacheEntry(): MountCacheEntry {
	return {
		lock: new AsyncLock(),
		overlays: new Map(),
		watchers: new Map(),
		state: { status: 'locked' },
		status: { phase: 'sealed', dirty: false },
	}
}

async function isMountPresent(store: VaultStore, runtime: MountRuntime): Promise<boolean> {
	return (await store.exists(runtime.keysPath)) || (await store.exists(runtime.statePath))
}

async function toRuntimeStatus(
	store: VaultStore,
	runtime: MountRuntime,
	entry: MountCacheEntry,
): Promise<VaultRuntimeStatus> {
	return {
		phase: entry.status.phase,
		present: await isMountPresent(store, runtime),
		dirty: entry.status.dirty,
		lastError: cloneStatusError(entry.status.lastError),
	}
}

function updateStatus(
	_store: VaultStore,
	_runtime: MountRuntime,
	entry: MountCacheEntry,
	patch: Partial<MountCacheEntry['status']>,
): void {
	const next: MountCacheEntry['status'] = {
		phase: patch.phase ?? entry.status.phase,
		dirty: patch.dirty ?? entry.status.dirty,
		lastError:
			patch.lastError !== undefined
				? cloneStatusError(patch.lastError)
				: cloneStatusError(entry.status.lastError),
	}
	if (sameStatusState(entry.status, next)) return
	entry.status = next
}

function clearStatusError(store: VaultStore, runtime: MountRuntime, entry: MountCacheEntry): void {
	if (!entry.status.lastError) return
	updateStatus(store, runtime, entry, { lastError: undefined })
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
	store: VaultStore,
	runtime: MountRuntime,
	entry: MountCacheEntry,
	error: unknown,
): void {
	updateStatus(store, runtime, entry, {
		phase: toFailurePhase(error),
		dirty: false,
		lastError: toStatusError(error),
	})
}

function namespaceFrom(ctx: PluxelContext, options?: VaultNamespaceOptions): string {
	const address = ctx.pluginInfo?.nodeAddress
	const base = address ? `plugin-${pluginNodePhysicalKey(address)}` : 'default'
	if (options?.namespace === undefined) return base
	validateKey(options.namespace)
	return address ? `${base}~${encodeURIComponent(options.namespace)}` : options.namespace
}

async function loadMountState(
	store: VaultStore,
	runtime: MountRuntime,
	options: { includeDeployIdentity?: boolean } = {},
): Promise<{ dek: Uint8Array; snapshot: VaultSnapshot } | undefined> {
	if (!(await store.exists(runtime.keysPath))) {
		if (await store.exists(runtime.statePath)) {
			throw new VaultError(
				'INVALID_FORMAT',
				`Vault mount is missing key envelope: ${runtime.keysPath}`,
			)
		}
		return undefined
	}

	const keys = await store.readBytes(runtime.keysPath)
	if (!keys) return undefined
	const dek = await decryptDek(store, runtime, keys, options)
	if (!(await store.exists(runtime.statePath)))
		throw new VaultError('INVALID_FORMAT', 'Vault snapshot is missing from an existing mount.')
	const stateBytes = await store.readBytes(runtime.statePath)
	if (!stateBytes)
		throw new VaultError('INVALID_FORMAT', 'Vault snapshot is missing from an existing mount.')
	const plaintext = await aesDecrypt(dek, stateBytes)
	return { dek, snapshot: parseSnapshot(plaintext) }
}

async function createMountKey(
	store: VaultStore,
	runtime: MountRuntime,
	deployRecipientsOverride?: string[],
	options: { createHostIdentity?: boolean } = {},
): Promise<Uint8Array> {
	const dek = randomBytes(32)
	await store.writeBytes(
		runtime.keysPath,
		await encryptDek(store, runtime, dek, deployRecipientsOverride, options),
	)
	return dek
}

async function createDeployKeyPair(): Promise<VaultKeyPair> {
	const envName = DEFAULT_DEPLOY_IDENTITY_ENV
	const privateKey = await generateIdentity()
	return {
		publicKey: await identityToRecipient(privateKey),
		privateKey,
		envName,
	}
}

async function flushUnlockedState(
	store: VaultStore,
	runtime: MountRuntime,
	state: Extract<MountCacheState, { status: 'unlocked' }>,
) {
	if (!state.dirty) return
	const ciphertext = await aesEncrypt(state.dek, serializeSnapshot(state.snapshot))
	await store.writeBytes(runtime.statePath, ciphertext)
	state.dirty = false
}

function clearTimer(state: Extract<MountCacheState, { status: 'unlocked' }>) {
	if (state.timer) {
		clearTimeout(state.timer)
		state.timer = null
	}
}

function cloneNamespaceState(state?: VaultSnapshot['namespaces'][string]) {
	return cloneJson(state ?? { kv: {}, revisions: {} })
}

function blobPath(runtime: MountRuntime, namespace: string, name: string): string {
	return join(runtime.blobsDir, namespace, `${normalizeSegment(name)}.blob`)
}

/**
 * Shared encrypted vault mount service.
 *
 * Design:
 * - one logical mount is a shared encrypted container
 * - `age` only wraps the mount DEK
 * - structured KV commits to an encrypted snapshot before publication
 * - blobs are separate symmetric files keyed by the same DEK
 */
export class VaultService {
	private managed?: ManagedVault

	private constructor(
		public readonly ctx: PluxelContext,
		private readonly backing: VaultRootBacking,
	) {
		pinOwnerContext(this, ctx)
	}

	static create(
		ctx: PluxelContext,
		config: VaultServiceConfig,
		storage?: PersistenceNamespace,
	): VaultService {
		const backing = createVaultRootBacking(ctx, config, storage)
		if (config.backend === 'bindings')
			backing.entry.state = {
				status: 'unlocked',
				dek: new Uint8Array(),
				snapshot: createEmptySnapshot(),
				unlockSource: 'host',
				dirty: false,
				timer: null,
				flushPromise: null,
			}
		return new VaultService(ctx, backing)
	}

	/** @internal Create an owner projection over the root-owned mount state. */
	forOwner(owner: PluxelContext): VaultService {
		return owner === this.ctx ? this : new VaultService(owner, this.backing)
	}

	isBindingsOnly(): boolean {
		return this.backing.runtime.backend === 'bindings'
	}

	/** Host-only bootstrap boundary; never exposed through the owner storage facade. */
	installBindings(records: readonly HostVaultBindingRecord[]): void {
		if (this.ctx !== this.ctx.root)
			throw new VaultError('ACCESS_DENIED', 'Vault bindings require the root Context.')
		const pending = new Map<string, Map<string, VaultRecordSnapshot>>()
		for (const record of records) {
			validateKey(record.key)
			const base = `plugin-${pluginNodePhysicalKey(record.owner)}`
			if (record.namespace !== undefined) validateKey(record.namespace)
			const namespace =
				record.namespace === undefined ? base : `${base}~${encodeURIComponent(record.namespace)}`
			const values = pending.get(namespace) ?? new Map(this.backing.entry.overlays.get(namespace))
			if (values.has(record.key))
				throw new VaultError('INVALID_CONFIG', 'Duplicate Vault deployment binding.')
			values.set(
				record.key,
				Object.freeze({
					key: record.key,
					exists: record.value !== undefined,
					value: record.value === undefined ? undefined : freezeJson(cloneJson(record.value)),
					revision: 1,
					source: record.source,
					writable: false,
				}),
			)
			pending.set(namespace, values)
		}
		for (const [namespace, values] of pending) this.backing.entry.overlays.set(namespace, values)
	}

	managedVault(): ManagedVault {
		if (this.managed) return this.managed
		const ctx = this.ctx
		const { store, runtime, entry } = this.backing

		const currentStatus = () => toRuntimeStatus(store, runtime, entry)

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
			updateStatus(store, runtime, entry, {
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
			updateStatus(store, runtime, entry, { phase: 'unlocking', dirty: false })
			const loaded = await loadMountState(store, runtime, {
				includeDeployIdentity: options.includeDeployIdentity,
			})
			if (!loaded) {
				updateStatus(store, runtime, entry, { phase: 'sealed', dirty: false, lastError: undefined })
				return undefined
			}
			return finalizeUnlockedState(loaded.dek, loaded.snapshot, options.source)
		}

		const resetAutoUnlockStatus = () => {
			updateStatus(store, runtime, entry, {
				phase: 'sealed',
				dirty: false,
				lastError: undefined,
			})
		}

		const ensureAutoUnlocked = async () => {
			if (entry.state.status === 'unlocked' || !(await isMountPresent(store, runtime)))
				return entry.state
			const deployIdentityPresent = await hasDeployIdentity(runtime)
			const hostIdentityPresent = await hasHostIdentity(store)
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

		const requireUnlockedState = (): Extract<MountCacheState, { status: 'unlocked' }> => {
			if (isUnlockedState(entry.state)) return entry.state
			throw new VaultError(
				'ACCESS_DENIED',
				`Vault mount "${SHARED_MOUNT}" is not prepared; the host must complete Context capability preparation before plugin startup.`,
			)
		}

		const mutateNamespace = async <T>(
			namespace: string,
			run: (next: VaultSnapshot['namespaces'][string]) => Promise<T>,
		): Promise<T> => {
			const changed: VaultRecordSnapshot[] = []
			const result = await runVaultOperation(ctx, () =>
				entry.lock.run(async () => {
					if (runtime.backend === 'bindings')
						throw new VaultError('READ_ONLY', 'Vault has no writable backend.')
					const state = requireUnlockedState()
					const previous = state.snapshot.namespaces[namespace]
					const next = cloneNamespaceState(previous)
					const transactionResult = await run(next)
					for (const key of Object.keys(next.revisions)) {
						if (next.revisions[key] !== previous?.revisions[key])
							changed.push(recordSnapshot(next, key, true))
					}
					if (changed.length === 0) return transactionResult
					const snapshot: VaultSnapshot = {
						...state.snapshot,
						namespaces: { ...state.snapshot.namespaces, [namespace]: next },
					}
					// Only publish after the encrypted atomic replace is confirmed.
					await store.writeBytes(
						runtime.statePath,
						await aesEncrypt(state.dek, serializeSnapshot(snapshot)),
					)
					state.snapshot = snapshot
					return transactionResult
				}),
			)
			for (const snapshot of changed)
				for (const observer of entry.watchers.get(namespace) ?? []) {
					if (
						observer.prefix ? snapshot.key.startsWith(observer.key) : observer.key === snapshot.key
					)
						observer.notify(snapshot)
				}
			return result
		}

		const readSnapshot = async <T>(
			run: (snapshot: VaultSnapshot) => T | Promise<T>,
		): Promise<T> => {
			return await runVaultOperation(ctx, () =>
				entry.lock.run(async () => {
					try {
						return await run(requireUnlockedState().snapshot)
					} catch (error) {
						setStatusFailure(store, runtime, entry, error)
						throw error
					}
				}),
			)
		}

		const readDek = async (createIfMissing: boolean) => {
			return await entry.lock.run(async () => {
				try {
					void createIfMissing
					if (runtime.backend === 'bindings')
						throw new VaultError('READ_ONLY', 'Vault has no blob backend.')
					return requireUnlockedState().dek
				} catch (error) {
					setStatusFailure(store, runtime, entry, error)
					throw error
				}
			})
		}

		const flush = async () => {
			await entry.lock.run(async () => {
				if (entry.state.status !== 'unlocked') return
				clearTimer(entry.state)
				if (entry.state.flushPromise) await entry.state.flushPromise
				entry.state.flushPromise = flushUnlockedState(store, runtime, entry.state)
					.then((): undefined => {
						updateStatus(store, runtime, entry, {
							phase: 'ready',
							dirty: false,
							lastError: undefined,
						})
						return undefined
					})
					.catch((error) => {
						setStatusFailure(store, runtime, entry, error)
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
			updateStatus(store, runtime, entry, { phase: 'sealed', dirty: false, lastError: undefined })
		}

		const rewriteEnvelope = async (deployRecipientsOverride?: string[]) => {
			if (!isUnlockedState(entry.state) && !(await isMountPresent(store, runtime))) {
				throw new VaultError(
					'MISSING_MOUNT',
					`Vault mount "${SHARED_MOUNT}" does not exist and can not be rekeyed.`,
				)
			}
			let dek: Uint8Array | undefined
			if (isUnlockedState(entry.state)) {
				dek = entry.state.dek
			} else {
				const loaded = await loadMountState(store, runtime, { includeDeployIdentity: true })
				dek = loaded?.dek ?? (await createMountKey(store, runtime, deployRecipientsOverride))
				if (loaded) {
					finalizeUnlockedState(
						loaded.dek,
						loaded.snapshot,
						(await hasDeployIdentity(runtime)) ? 'deploy' : 'host',
					)
				}
			}
			if (!dek) throw new VaultError('INVALID_CONFIG', 'Failed to load vault key for rekey.')
			await store.writeBytes(
				runtime.keysPath,
				await encryptDek(store, runtime, dek, deployRecipientsOverride),
			)
			clearStatusError(store, runtime, entry)
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
					setStatusFailure(store, runtime, entry, error)
					throw error
				}
			})
		}

		const probeUnlockState = async (): Promise<VaultProbeState> => {
			const status = await currentStatus()
			if (!status.present) return { unlockable: true, lastError: status.lastError }
			if (isUnlockedState(entry.state)) {
				return {
					unlockable: true,
					lastError: status.lastError,
				}
			}

			const hostIdentityPresent = await hasHostIdentity(store)
			const deployIdentityPresent = await hasDeployIdentity(runtime)
			if (!hostIdentityPresent && !deployIdentityPresent) {
				return {
					unlockable: false,
					reason: 'unlock_required',
					lastError: status.lastError,
				}
			}

			try {
				await loadMountState(store, runtime, { includeDeployIdentity: true })
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
			const snapshotOf = <T = unknown>(
				state: VaultSnapshot['namespaces'][string] | undefined,
				key: string,
			): VaultRecordSnapshot<T> => {
				validateKey(key)
				return (entry.overlays.get(namespace)?.get(key) ??
					recordSnapshot(state, key, runtime.backend === 'encrypted')) as VaultRecordSnapshot<T>
			}
			const keysOf = (
				state: VaultSnapshot['namespaces'][string] | undefined,
				options?: VaultListOptions,
			) => {
				const limit = options?.limit ?? 100
				if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
					throw new VaultError('INVALID_CONFIG', 'Vault list limit must be between 1 and 1000.')
				return Object.freeze(
					[
						...new Set([
							...Object.keys(state?.kv ?? {}),
							...(entry.overlays.get(namespace)?.keys() ?? []),
						]),
					]
						.filter(
							(key) =>
								(!options?.prefix || key.startsWith(options.prefix)) &&
								(!options?.after || key > options.after),
						)
						.sort()
						.slice(0, limit),
				)
			}
			const batch = <T>(run: (tx: VaultKvTransaction) => T | Promise<T>): Promise<T> =>
				mutateNamespace(namespace, async (state) => {
					let active = true
					const check = () => {
						if (!active) throw new VaultError('ACCESS_DENIED', 'Vault transaction is closed.')
					}
					const write = (
						key: string,
						value: unknown,
						options: VaultWriteOptions | undefined,
						remove: boolean,
					) => {
						check()
						validateKey(key)
						if (entry.overlays.get(namespace)?.has(key))
							throw new VaultError(
								'READ_ONLY',
								'Vault record is controlled by a deployment binding.',
							)
						const revision = state.revisions[key] ?? 0
						if (options?.expectedRevision !== undefined && options.expectedRevision !== revision)
							throw new VaultError('REVISION_CONFLICT', 'Vault record revision has changed.')
						if (revision >= Number.MAX_SAFE_INTEGER)
							throw new VaultError('INVALID_FORMAT', 'Vault revision exhausted.')
						if (remove) delete state.kv[key]
						else state.kv[key] = cloneJson(value)
						state.revisions[key] = revision + 1
						return snapshotOf(state, key)
					}
					try {
						return await run({
							get: (key) => {
								check()
								return snapshotOf(state, key)
							},
							set: (key, value, options) => write(key, value, options, false),
							delete: (key, options) => write(key, undefined, options, true),
							keys: (options) => {
								check()
								return keysOf(state, options)
							},
						})
					} finally {
						active = false
					}
				})
			const subscribe = (
				initial: readonly VaultRecordSnapshot[],
				key: string,
				prefix: boolean,
				listener: (snapshot: VaultRecordSnapshot) => void | Promise<void>,
			) => {
				let closed = false
				let running = false
				const revisions = new Map(initial.map((snapshot) => [snapshot.key, snapshot.revision]))
				const pending = new Map<string, VaultRecordSnapshot>()
				const observers = entry.watchers.get(namespace) ?? new Set()
				entry.watchers.set(namespace, observers)
				const dispose = () => {
					closed = true
					pending.clear()
					observers.delete(observer)
					if (observers.size === 0) entry.watchers.delete(namespace)
				}
				const schedule = () => {
					if (closed || running || pending.size === 0) return
					running = true
					const drain = async () => {
						await Promise.resolve()
						try {
							while (pending.size > 0 && !closed) {
								const next = pending.values().next().value!
								pending.delete(next.key)
								try {
									await runVaultOperation(ctx, () => Promise.resolve(listener(next)))
								} catch {
									/* Committed storage is independent of consumer application. */
								}
							}
						} finally {
							running = false
							schedule()
						}
					}
					void drain()
				}
				const observer = {
					key,
					prefix,
					notify(value: VaultRecordSnapshot) {
						if (closed || value.revision <= (revisions.get(value.key) ?? -1)) return
						revisions.set(value.key, value.revision)
						pending.set(value.key, value)
						schedule()
					},
				}
				observers.add(observer)
				ctx.effects.defer(dispose, { tag: 'VaultWatch' })
				return dispose
			}

			return {
				get: (key) => readSnapshot((snapshot) => snapshotOf(snapshot.namespaces[namespace], key)),
				set: async (key, value, options) => {
					const input = cloneJson(value)
					const expected = options ? { ...options } : undefined
					return batch((tx) => tx.set(key, input, expected))
				},
				delete: (key, options) => {
					const expected = options ? { ...options } : undefined
					return batch((tx) => tx.delete(key, expected))
				},
				keys: (options) =>
					readSnapshot((snapshot) => keysOf(snapshot.namespaces[namespace], options)),
				batch,
				watch: (key, listener) =>
					readSnapshot((snapshot) => {
						const initial = snapshotOf(snapshot.namespaces[namespace], key)
						return Object.freeze({
							snapshot: initial as never,
							dispose: subscribe([initial], key, false, listener as never),
						})
					}),
				watchPrefix: (prefix, listener) =>
					readSnapshot((snapshot) => {
						if (typeof prefix !== 'string' || prefix.length > 512)
							throw new VaultError('INVALID_CONFIG', 'Invalid Vault prefix.')
						const state = snapshot.namespaces[namespace]
						const keys = [
							...new Set([
								...Object.keys(state?.kv ?? {}),
								...(entry.overlays.get(namespace)?.keys() ?? []),
							]),
						]
							.filter((key) => key.startsWith(prefix))
							.sort()
						if (keys.length > 1000)
							throw new VaultError(
								'INVALID_CONFIG',
								'Vault watch prefix exceeds 1000 initial records.',
							)
						const initial = Object.freeze(keys.map((key) => snapshotOf(state, key)))
						return Object.freeze({
							snapshots: initial as never,
							dispose: subscribe(initial, prefix, true, listener as never),
						})
					}),
			}
		}

		const blobs = (namespaceOptions?: VaultNamespaceOptions): VaultBlobsHandle => {
			const namespace = namespaceFrom(ctx, namespaceOptions)
			return {
				open: (name: string): VaultBlobHandle => {
					const path = blobPath(runtime, namespace, name)
					const readBytes = () =>
						runVaultOperation(ctx, async () => {
							const dek = await readDek(false)
							const encrypted = await store.readBytes(path)
							return encrypted ? await aesDecrypt(dek, encrypted) : undefined
						})

					return {
						exists: () =>
							runVaultOperation(ctx, async () => {
								await readDek(false)
								return await store.exists(path)
							}),
						readBytes,
						readText: async () => {
							const bytes = await readBytes()
							return bytes ? textDecode(bytes) : undefined
						},
						writeBytes: (bytes: Uint8Array) =>
							runVaultOperation(ctx, async () => {
								const dek = await readDek(true)
								if (!dek) throw new VaultError('INVALID_CONFIG', 'Failed to create vault key.')
								await store.writeBytes(path, await aesEncrypt(dek, bytes))
							}),
						writeText: (text: string) =>
							runVaultOperation(ctx, async () => {
								await store.writeBytes(
									path,
									await aesEncrypt((await readDek(true))!, textEncode(text)),
								)
							}),
						remove: () =>
							runVaultOperation(ctx, async () => {
								if (await store.exists(path)) await store.delete(path)
							}),
						describe: () => ({ path }),
					}
				},
				list: () =>
					runVaultOperation(ctx, async () => {
						await entry.lock.run(async () => {
							try {
								requireUnlockedState()
							} catch (error) {
								setStatusFailure(store, runtime, entry, error)
								throw error
							}
						})
						const blobNames = await store.listChildren(join(runtime.blobsDir, namespace))
						return blobNames
							.filter((blobName) => blobName.endsWith('.blob'))
							.map((blobName) => blobName.slice(0, -'.blob'.length))
							.sort()
					}),
			}
		}

		const namespaceHandle = (name?: string): VaultNamespace => {
			const options = name === undefined ? undefined : { namespace: name }
			return {
				name: namespaceFrom(ctx, options),
				kv: () => kv(options),
				blobs: () => blobs(options),
			}
		}

		const describe = async (): Promise<VaultAdminState> => {
			if (runtime.backend === 'bindings')
				return {
					present: false,
					unlocked: true,
					unlockedBy: null,
					deploy: { env: DEFAULT_DEPLOY_IDENTITY_ENV, identityPresent: false, recipients: [] },
					hostIdentityPresent: false,
					namespaces: [],
				}
			const probe = await probeUnlockState()
			const unlocked = isUnlockedState(entry.state) ? entry.state : null
			const deployRecipients = await readDeployRecipients(store)
			const current = await currentStatus()
			let namespaces: VaultAdminState['namespaces'] | undefined
			if (unlocked) {
				const namespaceNames = new Set<string>(Object.keys(unlocked.snapshot.namespaces))
				for (const namespaceName of await store
					.listChildren(runtime.blobsDir)
					.catch((): string[] => [])) {
					if (namespaceName) namespaceNames.add(namespaceName)
				}

				namespaces = []
				for (const namespaceName of [...namespaceNames].sort()) {
					const snapshotState = unlocked.snapshot.namespaces[namespaceName]
					const blobNames = await store
						.listChildren(join(runtime.blobsDir, namespaceName))
						.catch((): string[] => [])
					const row: VaultNamespaceStats = {
						namespace: namespaceName,
						kvKeys: Object.keys(snapshotState?.kv ?? {}).length,
						blobs: blobNames.filter((name) => name.endsWith('.blob')).length,
					}
					namespaces.push(row)
				}
			}

			const reason = unlocked ? undefined : probe.reason
			const lastError = probe.lastError ?? current.lastError
			return {
				present: current.present,
				unlocked: unlocked !== null,
				...(reason === undefined ? {} : { reason }),
				unlockedBy: unlocked?.unlockSource ?? null,
				...(lastError === undefined ? {} : { lastError }),
				deploy: {
					env: DEFAULT_DEPLOY_IDENTITY_ENV,
					identityPresent: await hasDeployIdentity(runtime),
					recipients: deployRecipients,
				},
				hostIdentityPresent: await hasHostIdentity(store),
				...(namespaces === undefined ? {} : { namespaces }),
			}
		}

		const preflight = async (): Promise<VaultAdminState> => {
			if (runtime.backend === 'bindings') return describe()
			try {
				if (!(await isMountPresent(store, runtime))) {
					await entry.lock.run(async () => {
						if (isUnlockedState(entry.state)) return
						const dek = await createMountKey(store, runtime, undefined, {
							createHostIdentity: true,
						})
						const state = finalizeUnlockedState(dek, createEmptySnapshot(), 'host', true)
						await flushUnlockedState(store, runtime, state)
						updateStatus(store, runtime, entry, {
							phase: 'ready',
							dirty: false,
							lastError: undefined,
						})
					})
					recordSecurityEvent(ctx, {
						area: 'vault',
						action: 'preflight',
						status: 'success',
						mount: SHARED_MOUNT,
						message: `Vault mount "${SHARED_MOUNT}" initialized and ready for host startup.`,
					})
					return await describe()
				}

				await entry.lock.run(async () => {
					if (isUnlockedState(entry.state)) return
					const hostIdentityPresent = await hasHostIdentity(store)
					const deployIdentityPresent = await hasDeployIdentity(runtime)
					if (!hostIdentityPresent && !deployIdentityPresent) {
						const error = new VaultError(
							'ACCESS_DENIED',
							`Vault mount "${SHARED_MOUNT}" is sealed and can not be unlocked during host startup.`,
						)
						setStatusFailure(store, runtime, entry, error)
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
						clearStatusError(store, runtime, entry)
					} catch (error) {
						setStatusFailure(store, runtime, entry, error)
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
			if (runtime.backend === 'bindings') return describe()
			try {
				if (!(await isMountPresent(store, runtime))) {
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
					const hostIdentityPresent = await hasHostIdentity(store)
					const deployIdentityPresent = await hasDeployIdentity(runtime)
					if (!hostIdentityPresent && !deployIdentityPresent) return
					try {
						await ensureAutoUnlocked()
						if (isUnlockedState(entry.state)) clearStatusError(store, runtime, entry)
					} catch (error) {
						setStatusFailure(store, runtime, entry, error)
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
						error instanceof Error ? error.message : `Vault mount "${SHARED_MOUNT}" unlock failed.`,
				})
				throw error
			}
		}

		const vault: ManagedVault = {
			kv,
			blobs,
			namespace: namespaceHandle,
			unlock,
			flush,
			rekey,
			preflight,
			sealForRuntime,
			setDeployRecipients: async (recipients: string[]) => {
				const nextRecipients = normalizeRecipients(recipients)
				if (await isMountPresent(store, runtime)) {
					await entry.lock.run(async () => {
						try {
							await rewriteEnvelope(nextRecipients)
						} catch (error) {
							setStatusFailure(store, runtime, entry, error)
							throw error
						}
					})
				}
				await writeDeployRecipients(store, nextRecipients)
				return await describe()
			},
			ensureHostKey: async () => {
				if (runtime.backend === 'bindings')
					throw new VaultError('READ_ONLY', 'Vault has no encryption backend.')
				try {
					const identity = await ensureIdentity(store, true)
					if (!identity) throw new VaultError('MISSING_IDENTITY', 'Missing local age identity.')
					clearStatusError(store, runtime, entry)
					return await identityToRecipient(identity)
				} catch (error) {
					setStatusFailure(store, runtime, entry, error)
					throw error
				}
			},
			describe,
		}
		this.managed = vault
		return vault
	}

	kv(options?: VaultNamespaceOptions): VaultKvHandle {
		return this.managedVault().kv(options)
	}

	blobs(options?: VaultNamespaceOptions): VaultBlobsHandle {
		return this.managedVault().blobs(options)
	}

	namespace(name?: string): VaultNamespace {
		return this.managedVault().namespace(name)
	}

	flush(): Promise<void> {
		return runVaultOperation(this.ctx, () => this.managedVault().flush())
	}

	/** @internal Root admin projection reuses the immutable mount runtime inputs. */
	generateDeployKey(): Promise<VaultKeyPair> {
		return runVaultOperation(this.ctx, () => createDeployKeyPair())
	}

	/** @internal */
	async sealMountForTesting(): Promise<void> {
		await this.managedVault().sealForRuntime()
	}
}

export class VaultAdminService {
	constructor(
		public readonly ctx: PluxelContext,
		private readonly vault: VaultService,
	) {
		pinOwnerContext(this, ctx)
	}

	private managedVault(): ManagedVault {
		return this.vault.managedVault()
	}

	preflight(): Promise<VaultAdminState> {
		return runVaultOperation(this.ctx, () => this.managedVault().preflight())
	}

	async prepare(): Promise<VaultAdminState> {
		if (this.vault.isBindingsOnly()) return this.describe()
		const state = await this.describe()
		if (!state.present && !state.hostIdentityPresent) await this.ensureHostKey()
		return this.preflight()
	}

	describe(): Promise<VaultAdminState> {
		return runVaultOperation(this.ctx, () => this.managedVault().describe())
	}

	unlock(): Promise<VaultAdminState> {
		return runVaultOperation(this.ctx, () => this.managedVault().unlock())
	}

	rekey(): Promise<void> {
		return runVaultOperation(this.ctx, () => this.managedVault().rekey())
	}

	ensureHostKey(): Promise<string> {
		return runVaultOperation(this.ctx, () => this.managedVault().ensureHostKey())
	}

	setDeployRecipients(recipients: string[]): Promise<VaultAdminState> {
		return runVaultOperation(this.ctx, () => this.managedVault().setDeployRecipients(recipients))
	}

	generateDeployKey(): Promise<VaultKeyPair> {
		return this.vault.generateDeployKey()
	}
}

function createVaultRootBacking(
	ctx: PluxelContext,
	config: VaultServiceConfig,
	storage?: PersistenceNamespace,
): VaultRootBacking {
	if (ctx !== ctx.root) {
		throw new TypeError('[runtime:vault] Vault root backing requires the root Context')
	}
	return Object.freeze({
		store: storage
			? createVaultStore(storage)
			: {
					exists: async () => false,
					readText: async (): Promise<string | undefined> => undefined,
					readBytes: async (): Promise<Uint8Array | undefined> => undefined,
					listChildren: async (): Promise<string[]> => [],
					writeText: async () => {
						throw new VaultError('READ_ONLY', 'Vault has no persistent backend.')
					},
					writeBytes: async () => {
						throw new VaultError('READ_ONLY', 'Vault has no persistent backend.')
					},
					delete: async () => {
						throw new VaultError('READ_ONLY', 'Vault has no persistent backend.')
					},
				},
		runtime: resolveRuntime(config),
		entry: createMountCacheEntry(),
	})
}
