export {
	closeOwnerInvocations,
	enterOwnerInvocation,
	type OwnerInvocationLease,
} from './internal/owner-invocations'

/** @internal Optional service hook for immutable owner-bound Context capability views. */
export const OWNER_CONTEXT_BIND = Symbol.for('pluxel:ctx.owner-context-bind')

export { PluginSlotRegistry } from './plugins/runtime/identity'
export { PluginService } from './plugins/runtime/PluginService'
export type { PreparedRuntimeUpdateCommitOptions } from './plugins/runtime/plugin-service/RuntimeUpdateTransaction'
export {
	requirePluginGenerationInfo,
	type PluginGenerationInfo,
} from './plugins/runtime/PluginDefinitions'
export { requireConfigService } from './internal/config-service'
export { requirePluginService } from './internal/plugin-service'
export { checkPluginDecorator } from './plugins/decorators/decorator/api'
export {
	consumePluginDefinitionCandidate,
	type ConcretePluginDefinitionCandidate,
	type ConcretePluginDefinitionDeclaration,
	type PluginConfigDefinition,
} from './plugins/runtime/definition'
export type {
	PartConfigDeclaration,
	PluginPartDefinitionNode,
	PluginPartDefinitionTree,
} from './plugins/runtime/part-definition'
