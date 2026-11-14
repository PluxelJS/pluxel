import { createHash } from 'node:crypto'
import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { ScriptExecutionError, SCRIPT_VALUE_BYTES } from '@pluxel/host/agent'

export async function sourceHash(file: string): Promise<string> {
	await using handle = await open(file, 'r')
	const stat = await handle.stat()
	if (!stat.isFile())
		throw new ScriptExecutionError('file_not_allowed', 'Expected a regular source file')
	const bytes = Buffer.alloc(SCRIPT_VALUE_BYTES + 1)
	let size = 0
	while (size < bytes.length) {
		const chunk = await handle.read(bytes, size, bytes.length - size, null)
		if (chunk.bytesRead === 0) break
		size += chunk.bytesRead
	}
	if (size > SCRIPT_VALUE_BYTES)
		throw new ScriptExecutionError('source_too_large', 'Dev source file exceeds 1 MiB')
	return createHash('sha256').update(bytes.subarray(0, size)).digest('hex')
}

/** Only called for a watched, already imported source. Bound work before the route's synchronous admission. */
export function observedSourceHash(file: string): string {
	const descriptor = openSync(file, 'r')
	try {
		const stat = fstatSync(descriptor)
		if (!stat.isFile() || stat.size > SCRIPT_VALUE_BYTES)
			throw new ScriptExecutionError(
				'source_too_large',
				'Dev source file is not a bounded regular file',
			)
		const bytes = Buffer.alloc(SCRIPT_VALUE_BYTES + 1)
		let size = 0
		while (size < bytes.length) {
			const count = readSync(descriptor, bytes, size, bytes.length - size, null)
			if (count === 0) break
			size += count
		}
		if (size > SCRIPT_VALUE_BYTES)
			throw new ScriptExecutionError('source_too_large', 'Dev source file exceeds 1 MiB')
		return createHash('sha256').update(bytes.subarray(0, size)).digest('hex')
	} finally {
		closeSync(descriptor)
	}
}
