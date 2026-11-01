import { pluginNodeIndexKey, type PluginNodeAddress } from '../plugins/runtime/identity'
import type { Context, PluginContext, RootContext } from '../context/Context'
import type { CorePluginLifecycleHooks } from '../plugins/runtime/plugin-service/HostLifecycle'
import type { HostDocumentStorage } from '../storage/documents'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import type { FsService } from '../fs/service'
import { pluginNodePhysicalKey } from '../internal/plugin-address'
import { HostDocuments } from './documents'
import { TinyBaseError } from './error'
import { StoreWriter, runOperation } from './writer'
import type { TinyBaseHostService, TinyBaseService, TinyBaseStatus } from './types'

export class TinyBaseRuntime implements TinyBaseHostService {
	readonly lifecycle: CorePluginLifecycleHooks
	private readonly owners = new WeakMap<Context, StoreWriter>()
	private readonly published = new WeakSet<Context>()
	private readonly writers = new Map<string, StoreWriter>()
	private readonly namespaces = new Map<string, HostDocuments>()
	private readonly nodeBacking: HostDocumentStorage
	private readonly hostBacking: HostDocumentStorage
	private closed = false

	constructor(
		private readonly root: RootContext,
		private readonly fs: FsService,
		private readonly maxBytes: number,
	) {
		this.nodeBacking = fs.documents('services/tinybase/nodes')
		this.hostBacking = fs.documents('services/tinybase/host')
		this.lifecycle = {
			prepareCommit: ({ started }) => {
				for (const ctx of started) this.owners.get(ctx)?.preparePublication()
			},
			publishCommit: ({ started }) => {
				for (const ctx of started) {
					this.published.add(ctx)
					this.owners.get(ctx)?.publish()
				}
				return undefined
			},
		}
		root.effects.defer(() => this.close(), { tag: 'TinyBase', phase: 'final' })
	}

	forOwner(ctx: Context): TinyBaseService {
		if (!ctx.pluginInfo) throw new TypeError('[core.tinybase] A Plugin generation is required.')
		let writer = this.owners.get(ctx)
		if (!writer) {
			const node = ctx.pluginInfo.nodeAddress
			const key = pluginNodeIndexKey(node)
			writer = new StoreWriter(
				ctx as PluginContext,
				{
					...this.nodeBacking,
					getText: async (file) => {
						// open() is a writable capability even when this particular file already exists.
						await this.fs.ready({ writable: true })
						return this.nodeBacking.getText(file)
					},
				},
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

	documents(namespace: string): HostDocumentStorage {
		this.assertOpen()
		if (typeof namespace !== 'string' || namespace.length === 0 || namespace.length > 1024)
			throw new TypeError('[core.tinybase] Host namespace must contain 1 to 1024 characters.')
		let documents = this.namespaces.get(namespace)
		if (!documents) {
			const file = `${bytesToHex(sha256(new TextEncoder().encode(namespace)))}.json`
			documents = new HostDocuments(namespace, this.hostBacking, file, this.maxBytes, () =>
				this.fs.ready({ writable: true }),
			)
			this.namespaces.set(namespace, documents)
		}
		return documents
	}

	status(): readonly TinyBaseStatus[] {
		return [...this.writers.values(), ...this.namespaces.values()].map((writer) => writer.status())
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

	private async close(): Promise<void> {
		this.closed = true
		const results = await Promise.allSettled(
			[...this.namespaces.values()].map((documents) => documents.close()),
		)
		const errors = results.flatMap((result) =>
			result.status === 'rejected' ? [result.reason] : [],
		)
		// A Plugin's own final cleanup reports its failed writer. Do not retry or suppress that fault here.
		if (errors.length > 0)
			throw new AggregateError(errors, 'Failed to drain TinyBase Host documents')
	}

	private assertOpen(): void {
		if (this.closed) throw new Error('[core.tinybase] Host state service is closed.')
	}
}
