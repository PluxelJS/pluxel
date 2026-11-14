import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { readScriptCredentials } from '../src/script/client'

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
