import axios from 'axios'
import { gcm } from '@noble/ciphers/aes.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { CompactEncrypt, SignJWT, compactDecrypt, jwtVerify } from 'jose'
import semver from 'semver'
import wretch from 'wretch'
import YAML from 'yaml'
import { z } from 'zod'

const inputSchema = z
	.object({
		jsonrpc: z.literal('2.0'),
		id: z.union([z.string(), z.number().finite()]),
		method: z.literal('compatibility.run'),
		params: z.object({ echoUrl: z.string().url(), case: z.string().optional() }).strict(),
	})
	.strict()
const echoSchema = z.object({
	type: z.string(),
	body: z.string(),
	bodyBytes: z.array(z.number().int().min(0).max(255)),
	headers: z.record(z.string(), z.string()),
})
type Echo = z.infer<typeof echoSchema>
type Case = { name: string; ok: boolean; error?: string }
const lifetime = new AbortController()
let active: Promise<string> | undefined
let closed = false

function assert(value: unknown, message: string): asserts value {
	if (!value) throw new Error(message)
}
function containsBytes(haystack: readonly number[], needle: Uint8Array): boolean {
	outer: for (let offset = 0; offset <= haystack.length - needle.length; offset++) {
		for (let index = 0; index < needle.length; index++) {
			if (haystack[offset + index] !== needle[index]) continue outer
		}
		return true
	}
	return false
}
function verifyMultipart(value: Echo, bytes: Uint8Array, filename: string): void {
	assert(value.type.startsWith('multipart/form-data;'), `Unexpected content type: ${value.type}`)
	assert(value.body.includes(`filename="${filename}"`), 'Multipart filename missing')
	assert(containsBytes(value.bodyBytes, bytes), 'Multipart payload bytes changed')
}

async function run(text: string): Promise<string> {
	const input = inputSchema.parse(JSON.parse(text))
	const url = new URL(input.params.echoUrl)
	assert(url.protocol === 'http:' || url.protocol === 'https:', 'echoUrl must use HTTP(S)')
	const cases: Case[] = []
	const check = async (name: string, test: () => unknown | Promise<unknown>) => {
		if (input.params.case !== undefined && input.params.case !== name) return
		lifetime.signal.throwIfAborted()
		try {
			await test()
			cases.push({ name, ok: true })
		} catch (error) {
			cases.push({
				name,
				ok: false,
				error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
			})
		}
	}
	const echo = async (init: RequestInit = {}): Promise<Echo> => {
		const response = await fetch(url.href, { ...init, signal: lifetime.signal })
		assert(response.ok, `Echo HTTP ${response.status}`)
		return echoSchema.parse(await response.json())
	}

	await check('zod + yaml + semver', () => {
		const value = z.object({ version: z.string() }).strict().parse(YAML.parse('version: 1.2.3'))
		assert(semver.satisfies(value.version, '^1.0.0'), 'Version range did not match')
		assert(
			!z.object({ version: z.string() }).safeParse({ version: 42 }).success,
			'Zod accepted invalid input',
		)
	})
	await check('noble AES-GCM + SHA256', () => {
		const key = new Uint8Array(32).fill(1)
		const iv = new Uint8Array(12).fill(2)
		const plain = new TextEncoder().encode('hello')
		const encrypted = gcm(key, iv).encrypt(plain)
		assert(
			new TextDecoder().decode(gcm(key, iv).decrypt(encrypted)) === 'hello',
			'AES-GCM roundtrip changed bytes',
		)
		const digest = Array.from(sha256(plain), (byte) => byte.toString(16).padStart(2, '0')).join('')
		assert(
			digest === '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
			'SHA256 known vector mismatch',
		)
		encrypted[0] = encrypted[0]! ^ 1
		let rejected = false
		try {
			gcm(key, iv).decrypt(encrypted)
		} catch {
			rejected = true
		}
		assert(rejected, 'AES-GCM accepted tampered ciphertext')
	})
	await check('jose HS256 JWT sign/verify', async () => {
		const key = new Uint8Array(32).fill(1)
		const jwt = await new SignJWT({ sub: 'demo' }).setProtectedHeader({ alg: 'HS256' }).sign(key)
		const verified = await jwtVerify(jwt, key, { algorithms: ['HS256'] })
		assert(verified.payload.sub === 'demo', 'JWT payload mismatch')
	})
	await check('jose A256GCM JWE encrypt/decrypt', async () => {
		const key = new Uint8Array(32).fill(1)
		const jwe = await new CompactEncrypt(new TextEncoder().encode('hello'))
			.setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
			.encrypt(key)
		const decrypted = await compactDecrypt(jwe, key)
		assert(new TextDecoder().decode(decrypted.plaintext) === 'hello', 'JWE payload mismatch')
	})
	await check('wretch JSON POST', async () => {
		const value = echoSchema.parse(
			await wretch(url.href).options({ signal: lifetime.signal }).post({ hello: 'world' }).json(),
		)
		assert(JSON.parse(value.body).hello === 'world', 'Wretch JSON body mismatch')
	})
	await check('wretch multipart Blob upload', async () => {
		const bytes = new TextEncoder().encode('hello-file')
		const form = new FormData()
		form.append('file', new Blob([bytes]), 'demo.txt')
		const value = echoSchema.parse(
			await wretch(url.href).options({ signal: lifetime.signal }).post(form).json(),
		)
		verifyMultipart(value, bytes, 'demo.txt')
	})
	await check('axios browser default adapter JSON POST', async () => {
		const response = await axios.post(url.href, { hello: 'world' }, { signal: lifetime.signal })
		const value = echoSchema.parse(response.data)
		assert(JSON.parse(value.body).hello === 'world', 'Axios JSON body mismatch')
	})
	await check('fetch Blob multipart UTF-8 upload', async () => {
		const bytes = new TextEncoder().encode('hello-file 中文 café 😀')
		const form = new FormData()
		form.append('file', new Blob([bytes], { type: 'text/plain;charset=utf-8' }), 'utf8.txt')
		verifyMultipart(await echo({ method: 'POST', body: form }), bytes, 'utf8.txt')
	})
	await check('fetch Blob multipart binary upload', async () => {
		const bytes = new Uint8Array([0, 1, 2, 13, 10, 127, 128, 200, 254, 255])
		const form = new FormData()
		form.append('file', new Blob([bytes], { type: 'application/octet-stream' }), 'binary.bin')
		verifyMultipart(await echo({ method: 'POST', body: form }), bytes, 'binary.bin')
	})
	await check('fetch URL object', async () => {
		const response = await fetch(new URL(url), { signal: lifetime.signal })
		assert(response.ok, `URL object HTTP ${response.status}`)
		echoSchema.parse(await response.json())
	})
	await check('fetch abort reason identity', async () => {
		const reason = new Error('compatibility-custom-reason')
		const controller = new AbortController()
		controller.abort(reason)
		let received: unknown
		try {
			await fetch(url.href, { signal: controller.signal })
		} catch (error) {
			received = error
		}
		assert(received === reason, 'Fetch did not reject with the identical abort reason')
	})
	await check('Response.clone simultaneous body reads', async () => {
		const first = await fetch(url.href, { signal: lifetime.signal })
		assert(first.ok, `Response.clone HTTP ${first.status}`)
		const second = first.clone()
		const bodies = await Promise.all([first.text(), second.text()])
		assert(bodies[0] === bodies[1], 'Cloned bodies differ')
		echoSchema.parse(JSON.parse(bodies[0]!))
	})
	await check('fetch does not inject Origin', async () => {
		const value = await echo({ method: 'POST', body: 'origin-probe' })
		assert(
			!Object.keys(value.headers).some((key) => key.toLowerCase() === 'origin'),
			'Fetch added an unsolicited Origin header',
		)
	})
	await check('Symbol.dispose + Symbol.asyncDispose', () => {
		assert(
			typeof Symbol.dispose === 'symbol' && typeof Symbol.asyncDispose === 'symbol',
			'Disposal symbols unavailable',
		)
	})
	assert(cases.length > 0, `Unknown compatibility case: ${input.params.case}`)
	return JSON.stringify({
		jsonrpc: '2.0',
		id: input.id,
		result: { ok: cases.every((test) => test.ok), cases },
	})
}

export async function dispatch(text: string): Promise<string> {
	if (closed) throw new Error('Compatibility fixture closed')
	if (active) throw new Error('Compatibility fixture already running')
	active = run(text)
	try {
		return await active
	} finally {
		active = undefined
	}
}

export async function close(): Promise<void> {
	closed = true
	lifetime.abort(new Error('Compatibility fixture closed'))
	await active?.catch(() => {})
}
