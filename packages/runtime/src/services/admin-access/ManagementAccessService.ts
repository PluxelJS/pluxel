import type { Context as PluxelContext } from '@pluxel/core'
import { isPluginPartContext } from '@pluxel/core/internal'
import { pinOwnerContext } from '../../context/owner-view'
import type { AdminAccessService } from './AdminAccessService'
import type { ManagementAccessProvider, ManagementAccessRegistration } from './types'

/** Owner-bound registration surface for the host Management authentication provider. */
export class ManagementAccessService {
	constructor(
		public readonly ctx: PluxelContext,
		private readonly adminAccess: AdminAccessService,
	) {
		pinOwnerContext(this, ctx)
	}

	provide(provider: ManagementAccessProvider): ManagementAccessRegistration {
		if (!this.ctx.pluginInfo || isPluginPartContext(this.ctx)) {
			throw new TypeError(
				'[pluxel/runtime] Management access providers must be registered by a Plugin generation.',
			)
		}
		return this.adminAccess.provideFor(this.ctx, provider)
	}
}
