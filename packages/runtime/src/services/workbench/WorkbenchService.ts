import type { Context as CoreContext } from '@pluxel/core'
import { isPluginPartContext } from '@pluxel/core/internal'
import type { AnyWorkbenchExtension, WorkbenchBindings, WorkbenchMount } from '../../workbench'
import type { WorkbenchBackend } from '../workbench'
import { pinOwnerContext } from '../../context/owner-view'

export class WorkbenchService {
	constructor(
		public readonly ctx: CoreContext,
		private readonly backend: WorkbenchBackend,
	) {
		pinOwnerContext(this, ctx)
	}

	mount<
		Extension extends AnyWorkbenchExtension,
		const Bindings extends WorkbenchBindings<Extension>,
	>(extension: Extension, bindings: Bindings): WorkbenchMount<Extension, Bindings> {
		if (isPluginPartContext(this.ctx)) {
			throw new Error(
				'[pluxel/runtime] PluginPart cannot mount a Workbench extension directly; aggregate it in the owning Plugin mount.',
			)
		}
		return this.backend.forContext(this.ctx).mount(extension, bindings)
	}

	/** @internal Control-plane access to the host-owned backend. */
	requireBackend(): WorkbenchBackend {
		return this.backend
	}
}
