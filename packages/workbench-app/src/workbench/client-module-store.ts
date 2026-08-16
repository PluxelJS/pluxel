import type { WorkbenchBundle, WorkbenchPluginDescriptor } from '@pluxel/runtime/workbench'
import type { WorkbenchLocaleService, WorkbenchUiModule } from '@pluxel/runtime/workbench/ui'
import { workbenchNodeKey } from './node-address'

export type WorkbenchModuleRecord = {
	key: string
	owner: WorkbenchPluginDescriptor
	hash: string
	module: WorkbenchUiModule
	cleanup?: () => void
	holds: number
	refs: number
}

export type WorkbenchModuleLoader = (
	artifact: WorkbenchBundle,
) => Promise<WorkbenchUiModule | { default?: WorkbenchUiModule }>

export class WorkbenchModuleStore {
	private readonly records = new Map<string, WorkbenchModuleRecord>()
	private readonly pending = new Map<string, Promise<WorkbenchModuleRecord>>()

	constructor(
		private readonly locale: WorkbenchLocaleService,
		private readonly loadModule: WorkbenchModuleLoader,
	) {}

	async prepare(artifact: WorkbenchBundle): Promise<WorkbenchModuleRecord> {
		const key = `${workbenchNodeKey(artifact.owner.address)}:${artifact.sourceHash}`
		let record = this.records.get(key)
		if (!record) {
			let task = this.pending.get(key)
			if (task === undefined) {
				task = this.load(key, artifact)
				this.pending.set(key, task)
			}
			try {
				record = await task
			} finally {
				if (this.pending.get(key) === task) this.pending.delete(key)
			}
		}
		record.holds += 1
		return record
	}

	promote(records: Iterable<WorkbenchModuleRecord>): void {
		for (const record of records) {
			record.holds -= 1
			record.refs += 1
		}
	}

	releasePrepared(records: Iterable<WorkbenchModuleRecord>): void {
		for (const record of records) {
			record.holds -= 1
			this.collect(record)
		}
	}

	releaseActive(records: Iterable<WorkbenchModuleRecord>): void {
		for (const record of records) {
			record.refs -= 1
			this.collect(record)
		}
	}

	private async load(key: string, artifact: WorkbenchBundle): Promise<WorkbenchModuleRecord> {
		const imported = await this.loadModule(artifact)
		const module =
			imported && typeof imported === 'object' && 'default' in imported && imported.default
				? imported.default
				: (imported as WorkbenchUiModule)
		if (
			!module ||
			typeof module !== 'object' ||
			!module.views ||
			typeof module.contractFingerprint !== 'string'
		) {
			throw new Error(`[workbench-ui] invalid UI module for ${artifact.owner.displayName}`)
		}
		const cleanup = module.setup
			? await module.setup({ owner: artifact.owner, locale: this.locale })
			: undefined
		const record: WorkbenchModuleRecord = {
			key,
			owner: artifact.owner,
			hash: artifact.sourceHash,
			module,
			cleanup: typeof cleanup === 'function' ? cleanup : undefined,
			holds: 0,
			refs: 0,
		}
		this.records.set(key, record)
		return record
	}

	private collect(record: WorkbenchModuleRecord): void {
		if (record.holds > 0 || record.refs > 0) return
		if (this.records.get(record.key) !== record) return
		this.records.delete(record.key)
		this.cleanup(record)
	}

	private cleanup(record: WorkbenchModuleRecord): void {
		try {
			record.cleanup?.()
		} catch (error) {
			console.error(`[workbench-ui] remote cleanup failed (${record.owner.displayName})`, error)
		}
	}
}
