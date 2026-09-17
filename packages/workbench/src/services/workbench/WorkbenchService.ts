import type { Context as CoreContext } from '@pluxel/core'
import { isPluginPartContext } from '@pluxel/core/internal'
import type {
	AnyWorkbenchDefinition,
	PluginWorkbench,
	WorkbenchPublishBindings,
} from '../../workbench/definition.ts'
import type { WorkbenchBackend } from '../workbench.ts'
import { pinOwnerContext } from '@pluxel/services/internal/owner-view'

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
				'[workbench] PluginPart cannot publish Workbench entries; aggregate them in the owning Plugin definition.',
			)
		}
		this.backend.publish(this.ctx, definition, ...bindings)
	}
}
