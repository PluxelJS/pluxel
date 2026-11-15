import { open } from 'node:fs/promises'
import { ScriptExecutionError } from '@pluxel/host/internal/agent/runtime'
import type { HostCredentials } from '@pluxel/agent-sdk/client'
export async function readScriptCredentials(file?: string): Promise<HostCredentials> {
	if (!file) return {}
	await using handle = await open(file, 'r')
	const stat = await handle.stat()
	if (!stat.isFile())
		throw new ScriptExecutionError('invalid_credentials', 'Credential file must be a regular file')
	const bytes = Buffer.alloc(16 * 1024 + 1)
	let size = 0
	while (size < bytes.length) {
		const part = await handle.read(bytes, size, bytes.length - size, null)
		if (!part.bytesRead) break
		size += part.bytesRead
	}
	if (size > 16 * 1024)
		throw new ScriptExecutionError('invalid_credentials', 'Credential file exceeds 16 KiB')
	let value: unknown
	try {
		value = JSON.parse(bytes.subarray(0, size).toString('utf8'))
	} catch {
		throw new ScriptExecutionError('invalid_credentials', 'Credential file must contain valid JSON')
	}
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw new ScriptExecutionError(
			'invalid_credentials',
			'Credential file must be an object with password, code or cookie',
		)
	const entries = Object.entries(value)
	if (
		entries.some(
			([key, item]) =>
				!['password', 'code', 'cookie'].includes(key) ||
				typeof item !== 'string' ||
				!item ||
				item.length > 4096,
		)
	)
		throw new ScriptExecutionError(
			'invalid_credentials',
			'Credential file contains an unknown field or invalid credential',
		)
	return value as HostCredentials
}
