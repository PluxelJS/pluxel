import { BasePlugin, Plugin, withHost } from '@pluxel/test'
import { resolve } from 'pathe'
import { env as stdEnv } from 'std-env'
import { describe, expect, it } from 'vitest'

function bytesToHex(bytes: Uint8Array): string {
	let out = ''
	for (let i = 0; i < bytes.length; i++) out += bytes[i]!.toString(16).padStart(2, '0')
	return out
}

function randomHex(bytes: number): string {
	type WebCryptoLike = { getRandomValues: (array: Uint8Array) => Uint8Array }
	const c = (globalThis as unknown as { crypto?: WebCryptoLike }).crypto
	if (!c) throw new Error('WebCrypto is required for VaultService tests')
	const buf = new Uint8Array(bytes)
	c.getRandomValues(buf)
	return bytesToHex(buf)
}

function b64urlEncode(bytes: Uint8Array): string {
	const b64 = Buffer.from(bytes).toString('base64')
	return b64.replaceAll('+', '-').replaceAll('/', '_').replaceAll(/=+$/g, '')
}

function b64urlDecode(input: string): Uint8Array {
	const b64 = input.replaceAll('-', '+').replaceAll('_', '/')
	const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4))
	return new Uint8Array(Buffer.from(b64 + pad, 'base64'))
}

describe('VaultService (runtime)', () => {
	it('getToken/listKeys do not create files when vault is missing', async () => {
		const dir = `/vault/${randomHex(8)}`

		await withHost(
			async (host) => {
				@Plugin({ name: 'P' })
				class P extends BasePlugin {}

				host.add(P)
				await host.commit()

				const p = host.require(P)
				const vault = p.ctx.vault.open()

				expect(await vault.getToken('missing')).toBeUndefined()
				expect(await vault.listKeys()).toEqual([])
				expect(host.ctx.root.fs.debugListFiles(dir)).toEqual([])
			},
			{ fs: { mode: 'memory' }, vault: { dir } },
		)
	})

	it('batch() does not create files when there are no mutations', async () => {
		const dir = `/vault/${randomHex(8)}`

		await withHost(
			async (host) => {
				@Plugin({ name: 'P' })
				class P extends BasePlugin {}

				host.add(P)
				await host.commit()

				const p = host.require(P)
				const vault = p.ctx.vault.open()

				await vault.batch((tx) => {
					tx.getToken('x')
					tx.getSecret('y')
				})

				expect(host.ctx.root.fs.debugListFiles(dir)).toEqual([])
			},
			{ fs: { mode: 'memory' }, vault: { dir } },
		)
	})

	it('setToken creates vault.json and vault.key; lock() forces re-unlock from fs', async () => {
		const dir = `/vault/${randomHex(8)}`

		await withHost(
			async (host) => {
				@Plugin({ name: 'P' })
				class P extends BasePlugin {}

				host.add(P)
				await host.commit()

				const p = host.require(P)
				const vault = p.ctx.vault.open()

				await vault.setToken('github', 'ghp_test')
				expect(await vault.getToken('github')).toBe('ghp_test')

				vault.lock()
				expect(await vault.getToken('github')).toBe('ghp_test')

				const vaultPath = resolve(dir, 'P', 'vault.json')
				const keyPath = resolve(dir, 'P', 'vault.key')
				expect(host.ctx.root.fs.debugListFiles(dir)).toEqual([vaultPath, keyPath])
			},
			{ fs: { mode: 'memory' }, vault: { dir } },
		)
	})

	it('batch persists once for multiple mutations (fs stats)', async () => {
		const dir = `/vault/${randomHex(8)}`

		await withHost(
			async (host) => {
				@Plugin({ name: 'P' })
				class P extends BasePlugin {}

				host.add(P)
				await host.commit()

				const p = host.require(P)
				const vault = p.ctx.vault.open()

				await vault.setToken('a', '0')
				const before = host.ctx.root.fs.debugStats()

				await vault.batch((tx) => {
					tx.setToken('a', '1')
					tx.setToken('b', '2')
					tx.setSecret('json', { ok: true })
				})

				const after = host.ctx.root.fs.debugStats()
				expect(after.writeTextAtomic - before.writeTextAtomic).toBe(1)
				expect(await vault.getToken('a')).toBe('1')
				expect(await vault.getToken('b')).toBe('2')
			},
			{ fs: { mode: 'memory' }, vault: { dir } },
		)
	})

	it('rejects tampered ciphertext and enforces AAD binding', async () => {
		const dir = `/vault/${randomHex(8)}`

		await withHost(
			async (host) => {
				@Plugin({ name: 'P' })
				class P extends BasePlugin {}

				host.add(P)
				await host.commit()

				const p = host.require(P)
				const vault = p.ctx.vault.open()

				await vault.setToken('openai', 'sk-test')
				vault.lock()

				const vaultPath = resolve(dir, 'P', 'vault.json')
				const raw = await host.ctx.root.fs.readText(vaultPath)
				const goodRaw = raw
				const file = JSON.parse(raw)

				// Tamper ciphertext (AEAD integrity should fail).
				const ct = b64urlDecode(file.payload.ct)
				ct[0] = (ct[0] ^ 0x01) & 0xff
				file.payload.ct = b64urlEncode(ct)
				await host.ctx.root.fs.writeTextAtomic(vaultPath, JSON.stringify(file, null, 2))

				await expect(vault.getToken('openai')).rejects.toMatchObject({
					name: 'VaultError',
					code: 'DECRYPT_FAILED',
				})

				// Restore the original file for the next assertion.
				await host.ctx.root.fs.writeTextAtomic(vaultPath, goodRaw)
				vault.lock()

				const mismatched = p.ctx.vault.open({ aadString: 'different-aad' })
				await expect(mismatched.getToken('openai')).rejects.toMatchObject({
					name: 'VaultError',
					code: 'AAD_MISMATCH',
				})
			},
			{ fs: { mode: 'memory' }, vault: { dir } },
		)
	})

	it('supports env-based key material (no vault.key file)', async () => {
		const dir = `/vault/${randomHex(8)}`
		const envName = `PLUXEL_VAULT_KEY_${randomHex(6)}`

		const keyBytes = new Uint8Array(32).fill(7)
		stdEnv[envName] = bytesToHex(keyBytes)

		await withHost(
			async (host) => {
				@Plugin({ name: 'P' })
				class P extends BasePlugin {}

				host.add(P)
				await host.commit()

				const p = host.require(P)
				const vault = p.ctx.vault.open({ key: { env: envName, encoding: 'hex' } })

				await vault.setToken('t', 'v')
				vault.lock()

				const vaultPath = resolve(dir, 'P', 'vault.json')
				const keyPath = resolve(dir, 'P', 'vault.key')
				expect(host.ctx.root.fs.exists(vaultPath)).toBe(true)
				expect(host.ctx.root.fs.exists(keyPath)).toBe(false)

				const again = p.ctx.vault.open({ key: { env: envName, encoding: 'hex' } })
				expect(await again.getToken('t')).toBe('v')
			},
			{ fs: { mode: 'memory' }, vault: { dir } },
		)

		delete stdEnv[envName]
	})
})
