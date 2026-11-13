import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
	decodeScriptReceipt,
	encodeScriptReceipt,
	readScriptCredentials,
	verifyScriptReceipt,
} from '../src/script/client'
import type { ScriptRunSnapshot } from '@pluxel/host/agent'

const directories: string[] = []
afterEach(async () => {
	for (const directory of directories.splice(0))
		await rm(directory, { recursive: true, force: true })
})
it('reads bounded credentials without placing malformed private contents in errors', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'script-credentials-'))
	directories.push(directory)
	const file = join(directory, 'credentials.json')
	await writeFile(file, '{"password":"private-test-value"')
	const failure = await readScriptCredentials(file).catch((error: unknown) => error as Error)
	expect(failure).toMatchObject({ code: 'invalid_credentials' })
	expect(String(failure)).not.toContain('private-test-value')
	await writeFile(file, JSON.stringify({ password: 'private-test-value', unknown: true }))
	await expect(readScriptCredentials(file)).rejects.toMatchObject({ code: 'invalid_credentials' })
	await writeFile(file, ' '.repeat(16 * 1024 + 1))
	await expect(readScriptCredentials(file)).rejects.toMatchObject({ code: 'invalid_credentials' })
	await writeFile(file, JSON.stringify({ password: 'private-test-value' }))
	expect(await readScriptCredentials(file)).toEqual({ password: 'private-test-value' })
})
it('requires an original owner and content hash, and excludes endpoint credentials', () => {
	const receipt = {
		version: 2 as const,
		endpoint: 'https://host.test/',
		instanceId: 'owner',
		runId: 'operation',
		requestHash: 'a'.repeat(64),
	}
	const encoded = encodeScriptReceipt(receipt)
	expect(decodeScriptReceipt(encoded)).toEqual(receipt)
	for (const input of [
		encoded + '=',
		encodeScriptReceipt({ ...receipt, endpoint: 'https://secret:password@host.test/' }),
		encodeScriptReceipt({ ...receipt, requestHash: '' }),
		encodeScriptReceipt({ ...receipt, endpoint: 'https://host.test/another-route' }),
	])
		expect(() => decodeScriptReceipt(input)).toThrow(
			expect.objectContaining({ code: 'invalid_receipt' }),
		)
	expect(() =>
		verifyScriptReceipt(
			{
				instanceId: 'replacement',
				runId: receipt.runId,
				requestHash: receipt.requestHash,
			} as ScriptRunSnapshot,
			receipt,
		),
	).toThrow(expect.objectContaining({ code: 'receipt_mismatch' }))
})
