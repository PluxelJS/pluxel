import { pluginNodeIndexKey, type PluginNodeAddress } from '../plugins/runtime/identity'
import type { Context, PluginContext, RootContext } from '../context/Context'
import type { CoreStorage, CoreDocumentStorage } from '../storage/documents'
import { pluginNodePhysicalKey } from '../internal/plugin-address'
import { TinyBaseError } from './error'
import { StoreWriter, runOperation } from './writer'
import type { TinyBaseHostService, TinyBaseService, TinyBaseStatus } from './types'

export class TinyBaseRuntime implements TinyBaseHostService {
	private readonly owners = new WeakMap<Context, StoreWriter>()
	private readonly writers = new Map<string, StoreWriter>()
	private readonly nodeBacking: CoreDocumentStorage
	private readonly retention: ReturnType<CoreStorage['documents']['documentRetention']>
	private closed = false

	constructor(
		private readonly root: RootContext,
		storage: CoreStorage,
		private readonly maxBytes: number,
		private readonly published: WeakSet<Context>,
	) {
		const directory = 'services/tinybase/nodes'
		this.nodeBacking = storage.documents.documents(directory, maxBytes)
		this.retention = storage.documents.documentRetention(directory)
		root.effects.defer(() => this.close(), { tag: 'TinyBase', phase: 'final' })
	}

	preparePublication(started: readonly PluginContext[]): void {
		for (const ctx of started) this.owners.get(ctx)?.preparePublication()
	}

	publish(ctx: PluginContext): void {
		this.owners.get(ctx)?.publish()
	}

	forOwner(ctx: Context): TinyBaseService {
		if (!ctx.pluginInfo) throw new TypeError('[core.tinybase] A Plugin generation is required.')
		let writer = this.owners.get(ctx)
		if (!writer) {
			const node = ctx.pluginInfo.nodeAddress
			const key = pluginNodeIndexKey(node)
			writer = new StoreWriter(
				ctx as PluginContext,
				this.nodeBacking,
				this.retention,
				`${pluginNodePhysicalKey(node)}.json`,
				this.maxBytes,
				() => {
					this.assertOpen()
					const current = this.writers.get(key)
					if (current && current !== writer)
						throw new TinyBaseError(
							'WRITER_BLOCKED',
							'Another generation still owns this node, or its failed handover needs explicit recovery.',
							{ kind: 'plugin', node },
						)
					this.writers.set(key, writer!)
				},
				() => {
					if (this.writers.get(key) === writer) this.writers.delete(key)
				},
			)
			this.owners.set(ctx, writer)
			if (this.published.has(ctx)) writer.publish()
		}
		return writer
	}

	status(): readonly TinyBaseStatus[] {
		return [...this.writers.values()].map((writer) => writer.status())
	}

	recover(node: PluginNodeAddress, action: 'retry' | 'discard'): Promise<void> {
		if (action !== 'retry' && action !== 'discard')
			return Promise.reject(
				new TypeError('[core.tinybase] recovery action must be retry or discard'),
			)
		return runOperation(this.root, async () => {
			this.assertOpen()
			const writer = this.writers.get(pluginNodeIndexKey(node))
			if (!writer)
				throw new TinyBaseError('NOT_OPEN', 'No retained writer exists for this node.', {
					kind: 'plugin',
					node,
				})
			await writer.recover(action)
		})
	}

	private close(): void {
		this.closed = true
	}

	private assertOpen(): void {
		if (this.closed) throw new Error('[core.tinybase] Host state service is closed.')
	}
}
