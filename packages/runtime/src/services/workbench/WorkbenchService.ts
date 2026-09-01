import type { Context as CoreContext } from '@pluxel/core'
import { isPluginPartContext } from '@pluxel/core/internal'
import type {
	AnyWorkbenchDefinition,
	PluginWorkbench,
	WorkbenchPublishBindings,
} from '../../workbench/definition'
import type { WorkbenchBackend } from '../workbench'
import { pinOwnerContext } from '../../context/owner-view'

export class WorkbenchService implements PluginWorkbench {
	constructor(
		public readonly ctx: CoreContext,
		private readonly backend: WorkbenchBackend,
	) {
		pinOwnerContext(this, ctx)
	}

	publish<const Definition extends AnyWorkbenchDefinition>(
		definition: Definition,
		...bindings: WorkbenchPublishBindings<Definition>
	): void {
		if (isPluginPartContext(this.ctx)) {
			throw new Error(
				'[pluxel/runtime] PluginPart cannot publish Workbench entries; aggregate them in the owning Plugin definition.',
			)
		}
		this.backend.publish(this.ctx, definition, ...bindings)
	}

	/** @internal Control-plane access to the host-owned backend. */
	requireBackend(): WorkbenchBackend {
		return this.backend
	}
}
