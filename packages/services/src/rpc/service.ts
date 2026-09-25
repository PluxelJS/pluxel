import type { CommandContext, DirectCommand } from '@pluxel/commands'
import { pluginDefinitionIndexKey, type Context, type PluginDefinitionAddress } from '@pluxel/core'
import type { PluginRpcSite } from '@pluxel/core/internal'
import { installOwnerViewCapability } from '@pluxel/core/host'
import { defineHostService } from '@pluxel/host'
import { installHostRpcCatalogRegistrar } from '@pluxel/host/internal'
import { pinOwnerContext } from '../internal/owner-view'
import {
	RpcKernel,
	type RpcBuildPublication,
	type RpcPublication,
	type RpcPublicationOptions,
	type RpcSessionHandle,
	type RpcSessionOptions,
} from './kernel'
import { Rpc } from './token'

export { Rpc } from './token'

type CommandTable = Readonly<Record<string, DirectCommand<any, unknown, any>>>
type CommandContextOf<T> = T extends DirectCommand<any, unknown, infer Ctx> ? Ctx : CommandContext
type UnionToIntersection<T> = (T extends unknown ? (value: T) => void : never) extends (
	value: infer I,
) => void
	? I
	: never
type TableContext<T extends CommandTable> = UnionToIntersection<CommandContextOf<T[keyof T]>> &
	CommandContext
type BusinessContext<Ctx extends CommandContext> = Omit<Ctx, keyof CommandContext> & {
	readonly signal?: never
	readonly deadlineMs?: never
	readonly meta?: never
}

export type RpcPublishInput<T extends CommandTable> = Readonly<{
	id: string
	commands: T
	authorize?: RpcPublicationOptions['authorize']
}> &
	(CommandContext extends TableContext<NoInfer<T>>
		? {
				context?: (
					invocation: Parameters<NonNullable<RpcPublicationOptions['context']>>[0],
				) =>
					| BusinessContext<TableContext<NoInfer<T>>>
					| Promise<BusinessContext<TableContext<NoInfer<T>>>>
			}
		: {
				context: (
					invocation: Parameters<NonNullable<RpcPublicationOptions['context']>>[0],
				) =>
					| BusinessContext<TableContext<NoInfer<T>>>
					| Promise<BusinessContext<TableContext<NoInfer<T>>>>
			})

type TrustedSite = Readonly<{
	definition: PluginDefinitionAddress
	site: PluginRpcSite
}>

const trustedSites = new WeakMap<RpcService, WeakMap<object, TrustedSite>>()

function prepareTrustedSites(
	root: RpcService,
	entries: readonly Readonly<{
		definition: PluginDefinitionAddress
		sites: readonly PluginRpcSite[]
	}>[],
): () => void {
	const next = new WeakMap<object, TrustedSite>()
	const seenSites = new Set<string>()
	const seenArtifacts = new Set<object>()
	for (const entry of entries) {
		for (const site of entry.sites) {
			if (
				!site ||
				!site.artifact ||
				typeof site.artifact !== 'object' ||
				!Object.isFrozen(site.artifact) ||
				!Object.isFrozen(site.bindings) ||
				site.owner !== entry.definition.exportName ||
				seenSites.has(site.site) ||
				seenArtifacts.has(site.artifact)
			) {
				throw new TypeError('RPC catalog contains an invalid or duplicate build site')
			}
			seenSites.add(site.site)
			seenArtifacts.add(site.artifact)
			next.set(site.artifact, { definition: entry.definition, site })
		}
	}
	return () => {
		trustedSites.set(root, next)
	}
}

/** Owner-bound facade. Only the root may create an authorized session. */
export class RpcService {
	readonly #kernel?: RpcKernel

	constructor(
		public readonly ctx: Context,
		private readonly rootService?: RpcService,
	) {
		pinOwnerContext(this, ctx)
		if (!rootService) {
			trustedSites.set(this, new WeakMap())
			this.#kernel = new RpcKernel(ctx, {
				verifyArtifact: (artifact) =>
					trustedSites.get(this)?.get(artifact)?.site.bindings as
						| Readonly<Record<string, DirectCommand<any, unknown, any>>>
						| undefined,
			})
			ctx.effects.defer(
				() => {
					trustedSites.delete(this)
				},
				{ tag: 'RpcTrustedCatalog', phase: 'shutdown' },
			)
		}
	}

	publish<const T extends CommandTable>(input: RpcPublishInput<T>): RpcPublication {
		const root = this.rootService ?? this
		const generated = input as unknown as RpcBuildPublication & RpcPublicationOptions
		const site = trustedSites.get(root)?.get(generated.artifact)
		const definition = this.ctx.pluginInfo?.definitionAddress
		if (
			!site ||
			!definition ||
			pluginDefinitionIndexKey(definition) !== pluginDefinitionIndexKey(site.definition) ||
			site.site.bindings !== generated.bindings
		) {
			throw new TypeError('RPC publication is missing a trusted build site for this owner')
		}
		return root.#kernel!.publish(this.ctx, generated, {
			context: generated.context,
			authorize: generated.authorize,
		})
	}

	createSession(options: RpcSessionOptions): RpcSessionHandle {
		if (this.ctx !== this.ctx.root) throw new TypeError('RPC sessions require root authority')
		return this.#kernel!.createSession(options)
	}
}

/** Explicit RPC capability; absent hosts create no gateway, compiler or sandbox. */
export function rpc() {
	return defineHostService({
		name: 'Rpc',
		capabilities: [
			installOwnerViewCapability(Rpc, {
				property: 'rpc',
				createRoot: (root) => new RpcService(root as Context),
				createView: (rootService, owner) =>
					owner === owner.root ? rootService : new RpcService(owner as Context, rootService),
			}),
		],
		prepare({ ctx }) {
			const root = ctx.require(Rpc)
			installHostRpcCatalogRegistrar(ctx, {
				prepare: (sites) => prepareTrustedSites(root, sites),
			})
		},
	})
}

export type { RpcPublication, RpcSessionHandle, RpcSessionOptions }
