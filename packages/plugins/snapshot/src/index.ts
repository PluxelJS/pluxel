import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ui } from '@pluxel/hmr/plugin'
import { BasePlugin, Plugin } from '@pluxel/runtime'
import { buildSnapshotMainSource } from './buildMain'
import { buildSnapshotSource } from './buildSnapshot'
import { SnapshotRpc } from './rpc'

const snapshotUi = ui(fileURLToPath(new URL('./ui/index.tsx', import.meta.url)))

@Plugin({ name: 'Snapshot' })
export class SnapshotPlugin extends BasePlugin {
	override init(): void {
		// UI extension + RPC API (for host toolbar buttons).
		snapshotUi.bind(this.ctx)
		this.ctx.ext.rpc.expose(() => new SnapshotRpc(this))

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

		await this.ctx.root.fs.writeTextAtomic(configPath, configSource)
		await this.ctx.root.fs.writeTextAtomic(mainPath, mainSource)

		return { dir, configPath, mainPath }
	}

	async buildDist(): Promise<{ dir: string; entry: string }> {
		const { mainPath, configPath } = await this.generateSnapshotFiles()
		{
			const configSource = await this.ctx.root.fs.readText(configPath)
			if (configSource.includes(JSON.stringify('pluxel:builtins'))) {
				throw new Error(
					'Cannot build dist: snapshot imports "pluxel:builtins". ' +
						'Pass `moduleId` + `exportKey` for builtins in `hmrService.builtins`.',
				)
			}
		}

		const distDir = resolve(process.cwd(), '.pluxel/dist')
		// Keep heavy bundling deps out of the builtin baseline.
		// (They may be CJS-heavy and slow; only load when the action is invoked.)
		const { buildNodeDist } = await import('./buildDist')
		const res = await buildNodeDist({
			entry: mainPath,
			outDir: distDir,
		})

		return { dir: res.dir, entry: res.entry }
	}
}

export default SnapshotPlugin

declare module '@pluxel/runtime/web/ui' {
	interface ExtensionUiRpcMap {
		Snapshot: SnapshotRpc
	}
}
