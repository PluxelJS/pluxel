import { readFileSync, writeFileSync } from 'node:fs'
import { copyFile, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import {
	DEFAULT_IGNORED_DIR_NAMES,
	crawlFilesAbsWithFs,
	loadWorkspaceInfoWithFs,
	nodeWorkspaceFs,
	readTextFile,
	type WorkspaceFs,
} from '@pluxel/workspace/fs'
import type { FsServiceNodeBackendFs } from '@pluxel/runtime/services'

export {
	DEFAULT_IGNORED_DIR_NAMES,
	crawlFilesAbsWithFs,
	loadWorkspaceInfoWithFs,
	nodeWorkspaceFs,
	readTextFile,
}
export type { WorkspaceFs }

export type LoaderHmrWorkspaceFs = WorkspaceFs &
	FsServiceNodeBackendFs & {
		readFileSync(path: string, encoding: BufferEncoding): string
		writeFileSync(path: string, contents: string, encoding: BufferEncoding): void
		promises: WorkspaceFs['promises'] & FsServiceNodeBackendFs['promises']
	}

export const nodeLoaderHmrWorkspaceFs = {
	...nodeWorkspaceFs,
	readFileSync,
	writeFileSync,
	promises: {
		...nodeWorkspaceFs.promises,
		copyFile,
		mkdir,
		rename,
		rm,
		writeFile,
	},
} as LoaderHmrWorkspaceFs
