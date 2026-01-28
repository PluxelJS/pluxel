import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { BasePlugin, Plugin } from '@pluxel/hmr'
import { buildNodeDist } from './buildDist'

import { buildSnapshotSource } from './buildSnapshot'
import { buildSnapshotMainSource } from './buildMain'
import { SnapshotRpc } from './rpc'

@Plugin({ name: 'Snapshot' })
export class SnapshotPlugin extends BasePlugin {
	override init(): void {
		// UI extension + RPC API (for host toolbar buttons).
		this.ctx.ext.ui.register({ entryPath: uiEntryPath })
		this.ctx.ext.rpc.registerExtension(() => new SnapshotRpc(this))

		this.ctx.logger.info('Snapshot builtin ready')
	}

	private buildSnapshotConfigSource(): string {
		const { runtime, registry } = this.ctx.loader.api
		return buildSnapshotSource({
			ctx: this.ctx,
			entries: registry.listRegistered(),
			isRunning: (target) => runtime.isRunning(target),
			findModuleId: (name, ctor) => registry.findModuleId(name, ctor),
			getExportKey: (name) => registry.getExportKey(name),
			generatedBy: 'SnapshotPlugin',
		})
	}

	async generateSnapshotFiles(): Promise<{ dir: string; configPath: string; mainPath: string }> {
		const dir = resolve(process.cwd(), '.pluxel/snapshot')
		const configPath = resolve(dir, 'snapshot.config.ts')
		const mainPath = resolve(dir, 'snapshot.main.ts')

		const configSource = this.buildSnapshotConfigSource()
		if (configSource.includes(JSON.stringify('pluxel:builtins'))) {
			this.ctx.logger.warn(
				'Snapshot contains synthetic builtin module ids ("pluxel:builtins"). ' +
					'For runnable snapshots/dist builds, pass `moduleId` + `exportKey` in `hmrService.builtins`.',
			)
		}
		const mainSource = buildSnapshotMainSource({
			generatedBy: 'SnapshotPlugin',
			configImportPath: './snapshot.config',
		})

		await this.ctx.fs.writeTextAtomic(configPath, configSource)
		await this.ctx.fs.writeTextAtomic(mainPath, mainSource)

		return { dir, configPath, mainPath }
	}

	async buildDist(): Promise<{ dir: string; entry: string }> {
		const { mainPath, configPath } = await this.generateSnapshotFiles()
		{
			const configSource = await this.ctx.fs.readText(configPath)
			if (configSource.includes(JSON.stringify('pluxel:builtins'))) {
				throw new Error(
					'Cannot build dist: snapshot imports "pluxel:builtins". ' +
						'Pass `moduleId` + `exportKey` for builtins in `hmrService.builtins`.',
				)
			}
		}

		const distDir = resolve(process.cwd(), '.pluxel/dist')
		const res = await buildNodeDist({
			entry: mainPath,
			outDir: distDir,
		})

		return { dir: res.dir, entry: res.entry }
	}
}

// biome-ignore lint/style/noDefaultExport: plugin ctors are intentionally default-exported for ergonomic host imports.
export default SnapshotPlugin

const uiEntryPath = fileURLToPath(new URL('./ui/index.tsx', import.meta.url))

declare module '@pluxel/hmr/services' {
	namespace UI {
		interface rpc {
			Snapshot: SnapshotRpc
		}
	}
}
