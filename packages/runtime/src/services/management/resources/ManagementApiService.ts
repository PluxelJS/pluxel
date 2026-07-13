// Request-scoped Management API resources over Cap'n Web.
import { type Context } from '@pluxel/core'
import type { RpcTarget } from 'capnweb'

/** Request-scoped Management API resource factory. */
export type ManagementApiFactory<T extends RpcTarget = RpcTarget> = (ctx: Context) => T

export class ManagementApiService {
	private readonly resources = new Map<string, ManagementApiFactory>()

	constructor(
		public ctx: Context,
		_cfg: unknown,
	) {}

	/** @internal Register against an immutable owner Context. */
	registerResourceFor<T extends RpcTarget>(
		owner: Context,
		namespace: string,
		factory: ManagementApiFactory<T>,
	): () => void {
		if (this.resources.has(namespace)) {
			owner.logger.warn('Management API "{namespace}" already registered, overwriting', {
				namespace,
			})
		}

		this.resources.set(namespace, factory)

		const guard = owner.effects.defer(() => {
			if (this.resources.get(namespace) === factory) this.resources.delete(namespace)
		})
		return () => guard.dispose()
	}

	resolve(ctx: Context, namespace: string): RpcTarget {
		const factory = this.resources.get(namespace)
		if (!factory) throw new Error('[management] API resource is unavailable')
		return factory(ctx)
	}
}
