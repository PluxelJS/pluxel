import { RpcTarget } from '@pluxel/hmr/capnweb'
import type { SnapshotPlugin } from './index'

export type SnapshotFilesResult =
	| { ok: true; dir: string; configPath: string; mainPath: string }
	| { ok: false; error: string }

export type DistBuildResult =
	| { ok: true; dir: string; entry: string }
	| { ok: false; error: string }

export class SnapshotRpc extends RpcTarget {
	constructor(private readonly plugin: SnapshotPlugin) {
		super()
	}

	async generateSnapshotFiles(): Promise<SnapshotFilesResult> {
		try {
			const res = await this.plugin.generateSnapshotFiles()
			return { ok: true, ...res }
		} catch (error) {
			return { ok: false, error: (error as Error)?.message ?? 'Unknown error' }
		}
	}

	async buildDist(): Promise<DistBuildResult> {
		try {
			const res = await this.plugin.buildDist()
			return { ok: true, ...res }
		} catch (error) {
			return { ok: false, error: (error as Error)?.message ?? 'Unknown error' }
		}
	}
}

