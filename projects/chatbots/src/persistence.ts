import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { createWorkspacePersistenceBackend } from '@pluxel/runtime'

async function ensureParent(path: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true })
}

async function writeAtomic(path: string, value: string | Uint8Array): Promise<void> {
	await ensureParent(path)
	const temporary = `${path}.tmp-${process.pid}-${Date.now()}`
	await writeFile(temporary, value)
	await rename(temporary, path)
}

export function createChatbotsPersistence(root: string) {
	return createWorkspacePersistenceBackend(
		{
			exists: existsSync,
			readText: (path) => readFile(path, 'utf8'),
			writeTextAtomic: (path, text) => writeAtomic(path, text),
			readBytes: async (path) => new Uint8Array(await readFile(path)),
			writeBytesAtomic: (path, bytes) => writeAtomic(path, bytes),
			unlink,
			readdir,
			stat: async (path) => {
				try {
					const value = await stat(path)
					return {
						type: value.isDirectory() ? 'directory' : value.isFile() ? 'file' : 'other',
						size: value.size,
						mtimeMs: value.mtimeMs,
					} as const
				} catch (error) {
					if ((error as { code?: string }).code === 'ENOENT') return { type: 'missing' } as const
					throw error
				}
			},
		},
		{ root },
	)
}
