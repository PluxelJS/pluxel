import type { Context } from '@pluxel/core'
import {
	defineContextCapability,
	installRootCapability,
	installOwnerViewCapability,
	enterOwnerInvocation,
	type CoreCommitPublication,
} from '@pluxel/core/host'
import { defineHostService } from '@pluxel/host'
import type { Json } from './wire'
type Handler = (argv: readonly string[], signal: AbortSignal) => Promise<Json>
export const Cli = defineContextCapability<{ publish(handler: Handler): void }>(
	'launcher.cli.publisher',
	{ access: 'owner' },
)
export const CliControl = defineContextCapability<CliRegistry>('launcher.cli.control', {
	access: 'root',
})
export class CliRegistry {
	private readonly candidates = new Map<Context, Handler>()
	private active?: { owner: Context; handler: Handler }
	private prepared?: { owner: Context; handler: Handler }
	publish(owner: Context, handler: Handler) {
		if (this.candidates.has(owner)) throw new Error('CLI carrier already published')
		this.candidates.set(owner, handler)
		owner.effects.defer(
			() => {
				this.candidates.delete(owner)
				if (this.active?.owner === owner) this.active = undefined
			},
			{ tag: 'CLI carrier' },
		)
	}
	prepare(publication: CoreCommitPublication) {
		this.prepared = this.active
		for (const owner of publication.started) {
			const handler = this.candidates.get(owner)
			if (handler) {
				if (this.prepared) throw new Error('Only one CLI carrier may be active')
				this.prepared = { owner, handler }
			}
		}
	}
	commit(): undefined {
		this.active = this.prepared
		return undefined
	}
	async execute(argv: readonly string[]): Promise<Json> {
		if (
			!Array.isArray(argv) ||
			argv.length > 32 ||
			argv.some((token) => typeof token !== 'string' || token.length > 1024)
		)
			throw new TypeError('Invalid argv tokens')
		const current = this.active
		if (!current) throw new Error('CLI carrier unavailable')
		const admission = enterOwnerInvocation(current.owner)
		try {
			return await current.handler(argv, admission.signal)
		} finally {
			admission.dispose()
		}
	}
}
export function cli() {
	return defineHostService({
		name: 'Launcher CLI',
		capabilities: [
			installRootCapability(CliControl, { create: () => new CliRegistry() }),
			installOwnerViewCapability(Cli, {
				createRoot: (root) => root.require(CliControl),
				createView: (registry, owner) => ({
					publish: (handler: Handler) => registry.publish(owner, handler),
				}),
			}),
		],
		lifecycle(root) {
			const registry = root.require(CliControl)
			return {
				prepareCommit: (publication) => registry.prepare(publication),
				publishCommit: () => registry.commit(),
			}
		},
	})
}
