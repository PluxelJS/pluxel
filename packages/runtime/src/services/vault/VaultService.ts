import { scrypt as nobleScrypt } from '@noble/hashes/scrypt.js'
import { type Context, Injectable } from '@pluxel/core'
import { basename, resolve } from 'pathe'
import { env as stdEnv } from 'std-env'
import type { FsService } from '../fs/FsService'
import type {
	VaultFileV1,
	VaultHandle,
	VaultKeyfileSlotV1,
	VaultOpenOptions,
	VaultPassphraseSlotV1,
	VaultPayloadV1,
	VaultServiceConfig,
	VaultSlotV1,
} from './types'

const serviceName = 'vault' as const

declare module '@pluxel/core' {
	namespace Context {
		interface Config {
			[serviceName]?: VaultServiceConfig
		}
		interface Services {
			[serviceName]: VaultService
		}
	}
}

export class VaultError extends Error {
	/**
	 * Error codes:
	 * - `AAD_MISMATCH`: runtime `aadString` differs from stored AAD.
	 * - `DECRYPT_FAILED`: wrong material / tampered ciphertext / wrong nonce/AAD.
	 * - `INVALID_FORMAT`: file/payload structure mismatch or invalid `magic`.
	 * - `UNSUPPORTED`: unsupported algorithm/KDF in the current build.
	 * - `IO`: file read/write failures.
	 */
	public readonly code:
		| 'AAD_MISMATCH'
		| 'DECRYPT_FAILED'
		| 'INVALID_FORMAT'
		| 'MISSING_MATERIAL'
		| 'UNSUPPORTED'
		| 'IO'
	constructor(code: VaultError['code'], message: string, options?: { cause?: unknown }) {
		super(message)
		this.name = 'VaultError'
		this.code = code
		if (options?.cause !== undefined) (this as unknown as { cause?: unknown }).cause = options.cause
	}
}

type VaultPolicy = VaultFileV1['policy']

type VaultRuntime = {
	dir: string
	vaultPath: string
	keyfilePath: string
}

type FsLike = Pick<
	FsService,
	'exists' | 'readText' | 'writeTextAtomic' | 'readBytes' | 'writeBytesAtomic'
>

type VaultMaterial = {
	keyfileBytes?: Uint8Array
	passphrase?: string
	aadString?: string | null
}

type VaultMemState =
	| { status: 'locked' }
	| {
			status: 'unlocked'
			dek: Uint8Array
			payload: VaultPayloadV1
			aadBytes: Uint8Array
			file: VaultFileV1
	  }

type UnlockedState = Extract<VaultMemState, { status: 'unlocked' }>

class AsyncLock {
	private tail: Promise<void> = Promise.resolve()
	async run<T>(fn: () => Promise<T>): Promise<T> {
		const prev = this.tail
		let release!: () => void
		this.tail = new Promise<void>((r) => (release = r))
		await prev
		try {
			return await fn()
		} finally {
			release()
		}
	}
}

type VaultCacheEntry = {
	lock: AsyncLock
	state: VaultMemState
}

const VAULT_CACHE_SYMBOL = Symbol.for('pluxel:vault:cache')

function getVaultCache(): Map<string, VaultCacheEntry> {
	const g = globalThis as unknown as Record<symbol, unknown>
	const existing = g[VAULT_CACHE_SYMBOL]
	if (existing instanceof Map) return existing as Map<string, VaultCacheEntry>
	const created = new Map<string, VaultCacheEntry>()
	g[VAULT_CACHE_SYMBOL] = created
	return created
}

function getOrCreateCacheEntry(key: string): VaultCacheEntry {
	const cache = getVaultCache()
	const existing = cache.get(key)
	if (existing) return existing
	const entry: VaultCacheEntry = { lock: new AsyncLock(), state: { status: 'locked' } }
	cache.set(key, entry)
	return entry
}

const DEFAULT_DIR = 'data/vault'
const DEFAULT_HKDF_INFO = 'vault/v1 keyfile'
const DEFAULT_SCRYPT = { N: 1 << 14, r: 8, p: 1 } as const
const DEFAULT_SCRYPT_MAXMEM = 256 * 1024 * 1024

function normalizeNamespace(ns: string): string {
	const trimmed = ns || 'default'
	return basename(trimmed).replace(/[^A-Za-z0-9_-]/g, '_')
}

function nowIso(): string {
	return new Date().toISOString()
}

const B64_URL_TABLE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

const B64_DECODE_TABLE: Readonly<Record<string, number>> = (() => {
	const table: Record<string, number> = Object.create(null)
	for (let i = 0; i < B64_URL_TABLE.length; i++) table[B64_URL_TABLE[i]!] = i
	// Accept standard base64 too.
	table['+'] = 62
	table['/'] = 63
	return table
})()

function base64ToBytes(input: string): Uint8Array {
	const s = input.replace(/=+$/g, '')
	const len = s.length
	if (len === 0) return new Uint8Array()

	const rem = len % 4
	if (rem === 1) throw new VaultError('INVALID_FORMAT', 'Invalid base64 length')

	const full = ((len - rem) / 4) * 3
	const tail = rem === 2 ? 1 : rem === 3 ? 2 : 0
	const outLen = full + tail
	const out = new Uint8Array(outLen)

	let o = 0
	let i = 0
	for (; i + 4 <= len; i += 4) {
		const a = B64_DECODE_TABLE[s[i]!] ?? -1
		const b = B64_DECODE_TABLE[s[i + 1]!] ?? -1
		const c = B64_DECODE_TABLE[s[i + 2]!] ?? -1
		const d = B64_DECODE_TABLE[s[i + 3]!] ?? -1
		if (a < 0 || b < 0 || c < 0 || d < 0)
			throw new VaultError('INVALID_FORMAT', 'Invalid base64 char')

		const n = (a << 18) | (b << 12) | (c << 6) | d
		out[o++] = (n >>> 16) & 0xff
		out[o++] = (n >>> 8) & 0xff
		out[o++] = n & 0xff
	}

	if (rem === 2) {
		const a = B64_DECODE_TABLE[s[i]!] ?? -1
		const b = B64_DECODE_TABLE[s[i + 1]!] ?? -1
		if (a < 0 || b < 0) throw new VaultError('INVALID_FORMAT', 'Invalid base64 char')
		const n = (a << 18) | (b << 12)
		out[o++] = (n >>> 16) & 0xff
	} else if (rem === 3) {
		const a = B64_DECODE_TABLE[s[i]!] ?? -1
		const b = B64_DECODE_TABLE[s[i + 1]!] ?? -1
		const c = B64_DECODE_TABLE[s[i + 2]!] ?? -1
		if (a < 0 || b < 0 || c < 0) throw new VaultError('INVALID_FORMAT', 'Invalid base64 char')
		const n = (a << 18) | (b << 12) | (c << 6)
		out[o++] = (n >>> 16) & 0xff
		out[o++] = (n >>> 8) & 0xff
	}

	return out
}

function b64urlEncode(bytes: Uint8Array): string {
	const len = bytes.length
	if (len === 0) return ''

	let out = ''
	let i = 0
	for (; i + 3 <= len; i += 3) {
		const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!
		out += B64_URL_TABLE[(n >>> 18) & 63]
		out += B64_URL_TABLE[(n >>> 12) & 63]
		out += B64_URL_TABLE[(n >>> 6) & 63]
		out += B64_URL_TABLE[n & 63]
	}

	const rem = len - i
	if (rem === 1) {
		const n = bytes[i]! << 16
		out += B64_URL_TABLE[(n >>> 18) & 63]
		out += B64_URL_TABLE[(n >>> 12) & 63]
	} else if (rem === 2) {
		const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8)
		out += B64_URL_TABLE[(n >>> 18) & 63]
		out += B64_URL_TABLE[(n >>> 12) & 63]
		out += B64_URL_TABLE[(n >>> 6) & 63]
	}

	return out
}

function b64urlDecode(input: string): Uint8Array {
	return base64ToBytes(input)
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false
	let diff = 0
	for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
	return diff === 0
}

function textEncode(s: string): Uint8Array {
	return new TextEncoder().encode(s)
}

function textDecode(bytes: Uint8Array): string {
	return new TextDecoder().decode(bytes)
}

type WebCryptoLike = {
	subtle: {
		importKey: (...args: unknown[]) => Promise<unknown>
		encrypt: (...args: unknown[]) => Promise<ArrayBuffer>
		decrypt: (...args: unknown[]) => Promise<ArrayBuffer>
		deriveBits: (...args: unknown[]) => Promise<ArrayBuffer>
	}
	getRandomValues: <T extends ArrayBufferView>(array: T) => T
}

function getWebCrypto(): WebCryptoLike {
	const c = (globalThis as unknown as { crypto?: WebCryptoLike }).crypto
	if (!c || !c.subtle || !c.getRandomValues) {
		throw new VaultError('UNSUPPORTED', 'WebCrypto is not available in this runtime')
	}
	return c
}

function randomBytes(size: number): Uint8Array {
	const out = new Uint8Array(size)
	getWebCrypto().getRandomValues(out)
	return out
}

function resolveAadBytes(
	fileAadB64Url: string | undefined,
	runtimeAadString: string | null | undefined,
): { aadBytes: Uint8Array; aadB64Url?: string } {
	const fileAad = fileAadB64Url ? b64urlDecode(fileAadB64Url) : new Uint8Array()
	if (runtimeAadString === undefined) return { aadBytes: fileAad, aadB64Url: fileAadB64Url }
	const runtimeAad = runtimeAadString === null ? new Uint8Array() : textEncode(runtimeAadString)
	if (fileAadB64Url && !bytesEqual(fileAad, runtimeAad))
		throw new VaultError('AAD_MISMATCH', 'Vault AAD mismatch')
	return {
		aadBytes: runtimeAad,
		aadB64Url: runtimeAad.length ? b64urlEncode(runtimeAad) : undefined,
	}
}

async function aeadEncrypt(
	key32: Uint8Array,
	nonce: Uint8Array,
	aad: Uint8Array,
	plaintext: Uint8Array,
): Promise<Uint8Array> {
	const subtle = getWebCrypto().subtle
	const key = await subtle.importKey('raw', key32, { name: 'AES-GCM' }, false, ['encrypt'])
	const algo: { name: 'AES-GCM'; iv: Uint8Array; tagLength: number; additionalData?: Uint8Array } =
		{ name: 'AES-GCM', iv: nonce, tagLength: 128 }
	if (aad.length) algo.additionalData = aad
	const out = await subtle.encrypt(algo, key, plaintext)
	return new Uint8Array(out)
}

async function aeadDecrypt(
	key32: Uint8Array,
	nonce: Uint8Array,
	aad: Uint8Array,
	ciphertextWithTag: Uint8Array,
): Promise<Uint8Array> {
	if (ciphertextWithTag.length < 16) throw new VaultError('DECRYPT_FAILED', 'Decrypt failed')
	try {
		const subtle = getWebCrypto().subtle
		const key = await subtle.importKey('raw', key32, { name: 'AES-GCM' }, false, ['decrypt'])
		const algo: {
			name: 'AES-GCM'
			iv: Uint8Array
			tagLength: number
			additionalData?: Uint8Array
		} = { name: 'AES-GCM', iv: nonce, tagLength: 128 }
		if (aad.length) algo.additionalData = aad
		const out = await subtle.decrypt(algo, key, ciphertextWithTag)
		return new Uint8Array(out)
	} catch (cause) {
		throw new VaultError('DECRYPT_FAILED', 'Decrypt failed', { cause })
	}
}

async function hkdfSha256(
	ikm: Uint8Array,
	salt: Uint8Array,
	info: Uint8Array,
	len = 32,
): Promise<Uint8Array> {
	const subtle = getWebCrypto().subtle
	const baseKey = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits'])
	const bits = await subtle.deriveBits(
		{ name: 'HKDF', hash: 'SHA-256', salt, info },
		baseKey,
		len * 8,
	)
	return new Uint8Array(bits)
}

function scryptKek(
	passphrase: string,
	salt: Uint8Array,
	N: number,
	r: number,
	p: number,
): Uint8Array {
	return nobleScrypt(passphrase, salt, { N, r, p, dkLen: 32, maxmem: DEFAULT_SCRYPT_MAXMEM })
}

async function readJsonFile<T>(fs: FsLike, path: string): Promise<T> {
	try {
		const raw = await fs.readText(path)
		try {
			return JSON.parse(raw) as T
		} catch (cause) {
			throw new VaultError('INVALID_FORMAT', `Invalid JSON: ${path}`, { cause })
		}
	} catch (cause) {
		throw new VaultError('IO', `Failed to read vault file: ${path}`, { cause })
	}
}

async function writeVaultJson(fs: FsLike, path: string, file: VaultFileV1): Promise<void> {
	try {
		await fs.writeTextAtomic(path, JSON.stringify(file, null, 2))
	} catch (cause) {
		throw new VaultError('IO', `Failed to write vault file: ${path}`, { cause })
	}
}

function parseVaultPayload(bytes: Uint8Array): VaultPayloadV1 {
	let parsed: unknown
	try {
		parsed = JSON.parse(textDecode(bytes))
	} catch (cause) {
		throw new VaultError('INVALID_FORMAT', 'Invalid payload JSON', { cause })
	}
	if (!parsed || typeof parsed !== 'object')
		throw new VaultError('INVALID_FORMAT', 'Invalid payload')
	const obj = parsed as Record<string, unknown>
	if (obj.magic !== 'PV1') throw new VaultError('INVALID_FORMAT', 'Invalid vault magic')
	if (!obj.tokens || typeof obj.tokens !== 'object') obj.tokens = {}
	return obj as unknown as VaultPayloadV1
}

function createInitialPayload(): VaultPayloadV1 {
	return { magic: 'PV1', tokens: {} }
}

function validateVaultFile(vault: VaultFileV1): void {
	if (!vault || vault.v !== 1) throw new VaultError('INVALID_FORMAT', 'Unsupported vault version')
	if (!vault.payload) throw new VaultError('INVALID_FORMAT', 'Missing payload')
	if (!Array.isArray(vault.slots) || vault.slots.length === 0)
		throw new VaultError('INVALID_FORMAT', 'Missing slots')
	if (vault.payload.alg !== 'aes-256-gcm')
		throw new VaultError('UNSUPPORTED', `Unsupported payload alg: ${vault.payload.alg}`)
	for (const slot of vault.slots) {
		if (slot.wrap.alg !== 'aes-256-gcm')
			throw new VaultError('UNSUPPORTED', `Unsupported wrap alg: ${slot.wrap.alg}`)
		if (slot.type !== 'passphrase') continue
		const kdfAlg = (slot as unknown as { kdf?: { alg?: unknown } }).kdf?.alg
		if (kdfAlg !== 'scrypt' && kdfAlg !== 'argon2id') {
			throw new VaultError('UNSUPPORTED', `Unsupported KDF alg: ${String(kdfAlg)}`)
		}
	}
}

function getVaultConfig(ctx: Context): VaultServiceConfig {
	return ctx.config.vault ?? {}
}

function runtimePaths(
	ctx: Context,
	namespace: string,
	opts?: { dir?: string; keyfilePath?: string },
): VaultRuntime {
	const cfg = getVaultConfig(ctx)
	const base = resolve(opts?.dir ?? cfg.dir ?? DEFAULT_DIR)
	const safe = normalizeNamespace(namespace)
	const dir = resolve(base, safe)
	return {
		dir,
		vaultPath: resolve(dir, 'vault.json'),
		keyfilePath: resolve(opts?.keyfilePath ?? resolve(dir, 'vault.key')),
	}
}

function resolveDefaultAadString(ctx: Context, ns: string): string | null {
	const def = getVaultConfig(ctx).defaultAad
	if (def === false) return null
	if (typeof def === 'string') return def
	return `pluxel|plugin:${ns}`
}

function resolveEnvString(
	mapping: VaultServiceConfig['keyEnv'] | VaultServiceConfig['passphraseEnv'],
	namespace: string,
): string | undefined {
	if (!mapping) return undefined
	if (typeof mapping === 'string') return mapping
	return mapping[namespace]
}

function hexToBytes(hex: string): Uint8Array {
	const cleaned = hex.trim()
	if (cleaned.length % 2 !== 0) throw new VaultError('INVALID_FORMAT', 'Invalid hex string length')
	const out = new Uint8Array(cleaned.length / 2)
	for (let i = 0; i < out.length; i++) {
		const byte = Number.parseInt(cleaned.slice(i * 2, i * 2 + 2), 16)
		if (!Number.isFinite(byte)) throw new VaultError('INVALID_FORMAT', 'Invalid hex string')
		out[i] = byte
	}
	return out
}

function decodeEnvBytes(value: string, encoding: 'utf8' | 'base64' | 'hex'): Uint8Array {
	if (encoding === 'utf8') return textEncode(value)
	if (encoding === 'hex') return hexToBytes(value)
	return base64ToBytes(value)
}

function resolveMaterial(ctx: Context, ns: string, opts?: VaultOpenOptions): VaultMaterial {
	const cfg = getVaultConfig(ctx)

	const aadString = opts?.aadString ?? resolveDefaultAadString(ctx, ns)

	let keyfileBytes: Uint8Array | undefined
	if (opts?.key) {
		if ('bytes' in opts.key) keyfileBytes = opts.key.bytes
		else if ('env' in opts.key) {
			const raw = stdEnv[opts.key.env] as string | undefined
			if (raw) keyfileBytes = decodeEnvBytes(raw, opts.key.encoding ?? 'utf8')
		}
	} else {
		const envName = resolveEnvString(cfg.keyEnv, ns)
		if (envName) {
			const raw = stdEnv[envName] as string | undefined
			if (raw) keyfileBytes = textEncode(raw)
		}
	}

	let passphrase: string | undefined
	if (typeof opts?.passphrase === 'string') passphrase = opts.passphrase
	else if (opts?.passphrase && typeof opts.passphrase === 'object' && 'env' in opts.passphrase) {
		passphrase = stdEnv[opts.passphrase.env] as string | undefined
	} else {
		const envName = resolveEnvString(cfg.passphraseEnv, ns)
		if (envName) passphrase = stdEnv[envName] as string | undefined
	}

	return { keyfileBytes, passphrase, aadString }
}

async function ensureKeyfileWithFs(fs: FsLike, path: string): Promise<Uint8Array> {
	if (fs.exists(path)) {
		try {
			return await fs.readBytes(path)
		} catch {
			// fall through and re-create
		}
	}
	const bytes = randomBytes(32)
	await fs.writeBytesAtomic(path, bytes)
	return bytes
}

async function initVaultWithPayload(
	fs: FsLike,
	runtime: VaultRuntime,
	material: VaultMaterial,
	payload: VaultPayloadV1,
): Promise<{ file: VaultFileV1; dek: Uint8Array; payload: VaultPayloadV1; aadBytes: Uint8Array }> {
	const createdAt = nowIso()

	const { aadBytes, aadB64Url } = resolveAadBytes(undefined, material.aadString)

	const dek = randomBytes(32)

	const keyfileBytes = material.keyfileBytes ?? (await ensureKeyfileWithFs(fs, runtime.keyfilePath))
	const hkdfSalt = randomBytes(16)
	const kek = await hkdfSha256(keyfileBytes, hkdfSalt, textEncode(DEFAULT_HKDF_INFO), 32)
	const wrapNonce = randomBytes(24)
	const wrappedDek = await aeadEncrypt(kek, wrapNonce, aadBytes, dek)

	const payloadNonce = randomBytes(24)
	const payloadBytes = textEncode(JSON.stringify(payload))
	const payloadCt = await aeadEncrypt(dek, payloadNonce, aadBytes, payloadBytes)

	const file: VaultFileV1 = {
		v: 1,
		policy: 'ANY',
		createdAt,
		updatedAt: createdAt,
		payload: {
			alg: 'aes-256-gcm',
			nonce: b64urlEncode(payloadNonce),
			aad: aadB64Url,
			ct: b64urlEncode(payloadCt),
		},
		slots: [
			{
				type: 'keyfile',
				id: 'kf-1',
				hkdf: { salt: b64urlEncode(hkdfSalt), info: DEFAULT_HKDF_INFO },
				wrap: {
					alg: 'aes-256-gcm',
					nonce: b64urlEncode(wrapNonce),
					aad: aadB64Url,
					ct: b64urlEncode(wrappedDek),
				},
			},
		],
	}

	await writeVaultJson(fs, runtime.vaultPath, file)
	return { file, dek, payload, aadBytes }
}

async function initVault(
	fs: FsLike,
	runtime: VaultRuntime,
	material: VaultMaterial,
): Promise<VaultFileV1> {
	const { file } = await initVaultWithPayload(fs, runtime, material, createInitialPayload())
	return file
}

async function readOrInitVault(
	fs: FsLike,
	runtime: VaultRuntime,
	material: VaultMaterial,
): Promise<VaultFileV1> {
	if (!fs.exists(runtime.vaultPath)) return await initVault(fs, runtime, material)
	return await readJsonFile<VaultFileV1>(fs, runtime.vaultPath)
}

async function deriveKekFromKeyfile(
	slot: VaultKeyfileSlotV1,
	keyfileBytes: Uint8Array,
): Promise<Uint8Array> {
	const salt = b64urlDecode(slot.hkdf.salt)
	const info = textEncode(slot.hkdf.info)
	return await hkdfSha256(keyfileBytes, salt, info, 32)
}

function deriveKekFromPassphrase(slot: VaultPassphraseSlotV1, passphrase: string): Uint8Array {
	if (slot.kdf.alg === 'argon2id')
		throw new VaultError('UNSUPPORTED', 'argon2id KDF is not available in core build (use scrypt)')
	const salt = b64urlDecode(slot.kdf.salt)
	return scryptKek(passphrase, salt, slot.kdf.N, slot.kdf.r, slot.kdf.p)
}

async function decryptWrappedDek(
	slot: VaultSlotV1,
	aadBytes: Uint8Array,
	material: VaultMaterial,
): Promise<Uint8Array | null> {
	try {
		if (slot.type === 'keyfile') {
			if (!material.keyfileBytes) return null
			const kek = await deriveKekFromKeyfile(slot, material.keyfileBytes)
			return await aeadDecrypt(
				kek,
				b64urlDecode(slot.wrap.nonce),
				aadBytes,
				b64urlDecode(slot.wrap.ct),
			)
		}
		if (!material.passphrase) return null
		const kek = deriveKekFromPassphrase(slot, material.passphrase)
		return await aeadDecrypt(
			kek,
			b64urlDecode(slot.wrap.nonce),
			aadBytes,
			b64urlDecode(slot.wrap.ct),
		)
	} catch {
		return null
	}
}

async function unlockVault(
	fs: FsLike,
	runtime: VaultRuntime,
	file: VaultFileV1,
	material: VaultMaterial,
): Promise<{ dek: Uint8Array; payload: VaultPayloadV1; aadBytes: Uint8Array }> {
	validateVaultFile(file)
	const { aadBytes } = resolveAadBytes(file.payload.aad, material.aadString)

	if (!material.keyfileBytes && fs.exists(runtime.keyfilePath)) {
		try {
			material.keyfileBytes = await fs.readBytes(runtime.keyfilePath)
		} catch {
			// Best-effort: treat unreadable keyfiles as absent (decrypt will fail later if required by policy).
		}
	}

	let dek: Uint8Array | null = null
	if (file.policy === '2OF2') {
		const keySlot = file.slots.find((s) => s.type === 'keyfile')
		const passSlot = file.slots.find((s) => s.type === 'passphrase')
		if (!keySlot || !passSlot)
			throw new VaultError('INVALID_FORMAT', '2OF2 policy requires keyfile + passphrase slots')
		const dekA = await decryptWrappedDek(keySlot, aadBytes, material)
		const dekB = await decryptWrappedDek(passSlot, aadBytes, material)
		if (!dekA || !dekB) throw new VaultError('DECRYPT_FAILED', 'Decrypt failed')
		if (!bytesEqual(dekA, dekB)) throw new VaultError('DECRYPT_FAILED', 'Decrypt failed')
		dek = dekA
	} else {
		const allowed = file.policy === 'REQUIRE_PASSPHRASE' ? new Set(['passphrase']) : null
		for (const slot of file.slots) {
			if (allowed && !allowed.has(slot.type)) continue
			const maybe = await decryptWrappedDek(slot, aadBytes, material)
			if (maybe) {
				dek = maybe
				break
			}
		}
		if (!dek) throw new VaultError('DECRYPT_FAILED', 'Decrypt failed')
	}

	const payloadBytes = await aeadDecrypt(
		dek,
		b64urlDecode(file.payload.nonce),
		aadBytes,
		b64urlDecode(file.payload.ct),
	)
	const payload = parseVaultPayload(payloadBytes)
	return { dek, payload, aadBytes }
}

async function savePayload(
	fs: FsLike,
	runtime: VaultRuntime,
	file: VaultFileV1,
	dek: Uint8Array,
	aadBytes: Uint8Array,
	nextPayload: VaultPayloadV1,
): Promise<VaultFileV1> {
	const payloadNonce = randomBytes(24)
	const payloadBytes = textEncode(JSON.stringify(nextPayload))
	const payloadCt = await aeadEncrypt(dek, payloadNonce, aadBytes, payloadBytes)
	const updatedAt = nowIso()

	const next: VaultFileV1 = {
		...file,
		updatedAt,
		payload: { ...file.payload, nonce: b64urlEncode(payloadNonce), ct: b64urlEncode(payloadCt) },
	}
	await writeVaultJson(fs, runtime.vaultPath, next)
	return next
}

async function addPassphraseSlot(
	fs: FsLike,
	runtime: VaultRuntime,
	file: VaultFileV1,
	dek: Uint8Array,
	aadBytes: Uint8Array,
	passphrase: string,
	mode: 'keepAny' | 'requirePassphrase' | 'twoFactor' = 'keepAny',
): Promise<VaultFileV1> {
	const salt = randomBytes(16)
	const kek = scryptKek(passphrase, salt, DEFAULT_SCRYPT.N, DEFAULT_SCRYPT.r, DEFAULT_SCRYPT.p)
	const wrapNonce = randomBytes(24)
	const wrappedDek = await aeadEncrypt(kek, wrapNonce, aadBytes, dek)

	const policy: VaultPolicy =
		mode === 'twoFactor' ? '2OF2' : mode === 'requirePassphrase' ? 'REQUIRE_PASSPHRASE' : 'ANY'

	const next: VaultFileV1 = {
		...file,
		policy,
		updatedAt: nowIso(),
		slots: [
			...file.slots.filter((s) => s.type !== 'passphrase'),
			{
				type: 'passphrase',
				id: 'pw-1',
				kdf: { alg: 'scrypt', ...DEFAULT_SCRYPT, salt: b64urlEncode(salt) },
				wrap: {
					alg: 'aes-256-gcm',
					nonce: b64urlEncode(wrapNonce),
					aad: file.payload.aad,
					ct: b64urlEncode(wrappedDek),
				},
			},
		],
	}

	await writeVaultJson(fs, runtime.vaultPath, next)
	return next
}

function clonePayload(payload: VaultPayloadV1): VaultPayloadV1 {
	return {
		...payload,
		tokens: { ...(payload.tokens ?? {}) },
		secrets: payload.secrets ? { ...payload.secrets } : undefined,
		meta: payload.meta ? { ...payload.meta } : undefined,
	}
}

/**
 * Encrypted storage for plugins (Portable Vault v1).
 *
 * Access via `ctx.vault` inside a plugin context.
 */
@Injectable({ key: serviceName })
export class VaultService {
	constructor(public ctx: Context) {}

	/**
	 * Open a vault handle (defaults to current plugin namespace).
	 *
	 * Performance model:
	 * - Read-only operations do not create files when the vault is missing.
	 * - The first operation that needs persistence (e.g. `setToken`) initializes the vault on disk.
	 *   - First write on a missing vault avoids an extra decrypt/rewrite pass (init writes the final payload once).
	 * - First successful unlock decrypts and caches `{DEK + payload}` in memory for this process.
	 * - Subsequent reads are memory-only (no decrypt) until `lock()` is called.
	 * - Each persisted write re-encrypts payload (fresh nonce) and atomically writes `vault.json`.
	 * - Use `batch()` to merge many writes into a single encrypt+write.
	 */
	open(options: VaultOpenOptions = {}): VaultHandle {
		const ctx = this.ctx
		const fs: FsLike = ctx.root.fs
		const ns = options.namespace ?? ctx.pluginInfo?.id ?? 'default'

		const namespace = normalizeNamespace(ns)
		const runtime = runtimePaths(ctx, namespace, {
			dir: options.dir,
			keyfilePath:
				options.key && 'keyfilePath' in options.key ? options.key.keyfilePath : undefined,
		})

		const entry = getOrCreateCacheEntry(runtime.vaultPath)

		async function withUnlocked<T>(
			createIfMissing: true,
			fn: (state: UnlockedState) => Promise<T>,
		): Promise<T>
		async function withUnlocked<T>(
			createIfMissing: false,
			fn: (state: UnlockedState) => Promise<T>,
		): Promise<T | undefined>
		async function withUnlocked<T>(
			createIfMissing: boolean,
			fn: (state: UnlockedState) => Promise<T>,
		): Promise<T | undefined> {
			return await entry.lock.run(async () => {
				if (entry.state.status !== 'unlocked') {
					if (!fs.exists(runtime.vaultPath)) {
						if (!createIfMissing) return undefined
					}

					const material = resolveMaterial(ctx, namespace, options)
					const file = createIfMissing
						? await readOrInitVault(fs, runtime, material)
						: await readJsonFile<VaultFileV1>(fs, runtime.vaultPath)

					const { dek, payload, aadBytes } = await unlockVault(fs, runtime, file, material)
					entry.state = { status: 'unlocked', dek, payload, aadBytes, file }
				}

				return await fn(entry.state)
			})
		}

		const persistPayload = async (mutate: (payload: VaultPayloadV1) => void): Promise<void> => {
			await entry.lock.run(async () => {
				if (entry.state.status !== 'unlocked') {
					const material = resolveMaterial(ctx, namespace, options)

					// Fast path: first write on a missing vault should not do a "double encrypt+write".
					if (!fs.exists(runtime.vaultPath)) {
						const payload = createInitialPayload()
						mutate(payload)
						const { file, dek, aadBytes } = await initVaultWithPayload(
							fs,
							runtime,
							material,
							payload,
						)
						entry.state = { status: 'unlocked', dek, payload, aadBytes, file }
						return
					}

					const file = await readJsonFile<VaultFileV1>(fs, runtime.vaultPath)
					const { dek, payload, aadBytes } = await unlockVault(fs, runtime, file, material)
					entry.state = { status: 'unlocked', dek, payload, aadBytes, file }
				}

				const state = entry.state
				if (state.status !== 'unlocked') return

				const nextPayload = clonePayload(state.payload)
				mutate(nextPayload)
				const nextFile = await savePayload(
					fs,
					runtime,
					state.file,
					state.dek,
					state.aadBytes,
					nextPayload,
				)
				entry.state = { ...state, payload: nextPayload, file: nextFile }
			})
		}

		return {
			getToken: async (name) =>
				(await withUnlocked(false, async (state) => state.payload.tokens?.[name])) ?? undefined,
			setToken: async (name, value) => {
				await persistPayload((p) => {
					p.tokens = p.tokens ?? {}
					p.tokens[name] = value
				})
			},
			setTokens: async (tokens) => {
				await persistPayload((p) => {
					const next = p.tokens ?? {}
					for (const [k, v] of Object.entries(tokens)) next[k] = v
					p.tokens = next
				})
			},
			deleteToken: async (name) => {
				await persistPayload((p) => {
					if (!p.tokens) return
					delete p.tokens[name]
				})
			},
			getSecret: async <T>(name: string) =>
				(await withUnlocked(
					false,
					async (state) => state.payload.secrets?.[name] as T | undefined,
				)) ?? undefined,
			setSecret: async (name, value) => {
				await persistPayload((p) => {
					p.secrets = p.secrets ?? {}
					p.secrets[name] = value
				})
			},
			setSecrets: async (secrets) => {
				await persistPayload((p) => {
					const next = p.secrets ?? {}
					for (const [k, v] of Object.entries(secrets)) next[k] = v
					p.secrets = next
				})
			},
			deleteSecret: async (name) => {
				await persistPayload((p) => {
					if (!p.secrets) return
					delete p.secrets[name]
				})
			},
			listKeys: async () =>
				(await withUnlocked(false, async (state) => {
					const keys = new Set<string>()
					for (const k of Object.keys(state.payload.tokens ?? {})) keys.add(k)
					for (const k of Object.keys(state.payload.secrets ?? {})) keys.add(k)
					return [...keys].sort()
				})) ?? [],
			addPassphrase: async (passphrase, mode = 'keepAny') => {
				await withUnlocked(true, async (state) => {
					const nextFile = await addPassphraseSlot(
						fs,
						runtime,
						state.file,
						state.dek,
						state.aadBytes,
						passphrase,
						mode,
					)
					entry.state = { ...state, file: nextFile }
				})
			},
			batch: async (run) => {
				return await entry.lock.run(async () => {
					const runTx = async (draft: VaultPayloadV1) => {
						let dirty = false
						const tx = {
							getToken: (name: string) => draft.tokens?.[name],
							setToken: (name: string, value: string) => {
								dirty = true
								draft.tokens = draft.tokens ?? {}
								draft.tokens[name] = value
							},
							deleteToken: (name: string) => {
								if (!draft.tokens || !(name in draft.tokens)) return
								dirty = true
								delete draft.tokens[name]
							},
							getSecret: <T = unknown>(name: string) => draft.secrets?.[name] as T | undefined,
							setSecret: (name: string, value: unknown) => {
								dirty = true
								draft.secrets = draft.secrets ?? {}
								draft.secrets[name] = value
							},
							deleteSecret: (name: string) => {
								if (!draft.secrets || !(name in draft.secrets)) return
								dirty = true
								delete draft.secrets[name]
							},
						}
						const result = await run(tx)
						return { dirty, result }
					}

					// Already unlocked: draft, run, maybe persist.
					if (entry.state.status === 'unlocked') {
						const state = entry.state
						const draft = clonePayload(state.payload)
						const { dirty, result } = await runTx(draft)
						if (!dirty) return result

						const nextFile = await savePayload(
							fs,
							runtime,
							state.file,
							state.dek,
							state.aadBytes,
							draft,
						)
						entry.state = { ...state, payload: draft, file: nextFile }
						return result
					}

					// Missing vault: run against an empty draft first; only create+persist if dirty.
					if (!fs.exists(runtime.vaultPath)) {
						const draft = createInitialPayload()
						const { dirty, result } = await runTx(draft)
						if (!dirty) return result

						const material = resolveMaterial(ctx, namespace, options)
						const { file, dek, aadBytes } = await initVaultWithPayload(fs, runtime, material, draft)
						entry.state = { status: 'unlocked', dek, payload: draft, aadBytes, file }
						return result
					}

					// Existing vault: unlock once (cache), then run+persist if dirty.
					const material = resolveMaterial(ctx, namespace, options)
					const file = await readJsonFile<VaultFileV1>(fs, runtime.vaultPath)
					const { dek, payload, aadBytes } = await unlockVault(fs, runtime, file, material)
					entry.state = { status: 'unlocked', dek, payload, aadBytes, file }

					const state = entry.state
					if (state.status !== 'unlocked') throw new VaultError('IO', 'Failed to unlock vault')

					const draft = clonePayload(state.payload)
					const { dirty, result } = await runTx(draft)
					if (!dirty) return result

					const nextFile = await savePayload(
						fs,
						runtime,
						state.file,
						state.dek,
						state.aadBytes,
						draft,
					)
					entry.state = { ...state, payload: draft, file: nextFile }
					return result
				})
			},
			lock: () => {
				entry.state = { status: 'locked' }
			},
		}
	}
}
