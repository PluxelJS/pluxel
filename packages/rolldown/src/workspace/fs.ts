import { existsSync } from 'node:fs'
import { readFile, readdir, realpath, stat } from 'node:fs/promises'

export type WorkspaceDirEntryLike = {
	name: string
	isDirectory?: () => boolean
	isFile?: () => boolean
	isSymbolicLink?: () => boolean
}

export type WorkspaceStatsLike = {
	isDirectory?: () => boolean
	isFile?: () => boolean
	isSymbolicLink?: () => boolean
	size?: number
	mtimeMs?: number
}

export type WorkspaceFs = {
	existsSync(path: string): boolean
	promises: {
		readFile(
			path: string,
			options?: BufferEncoding | { encoding?: BufferEncoding | null } | null,
		): Promise<string | Buffer>
		readdir: {
			(path: string, options: { withFileTypes: true }): Promise<WorkspaceDirEntryLike[]>
			(path: string, options?: { withFileTypes?: false }): Promise<string[]>
		}
		realpath(path: string): Promise<string>
		stat(path: string): Promise<WorkspaceStatsLike>
	}
}

export const nodeWorkspaceFs: WorkspaceFs = {
	existsSync,
	promises: {
		readFile,
		readdir: readdir as WorkspaceFs['promises']['readdir'],
		realpath,
		stat: stat as WorkspaceFs['promises']['stat'],
	},
}

export async function readTextFile(fs: WorkspaceFs, path: string): Promise<string> {
	const content = await fs.promises.readFile(path, 'utf8')
	return typeof content === 'string' ? content : content.toString('utf8')
}
