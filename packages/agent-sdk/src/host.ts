/** Operations on an existing Host. This entry does not load the source compiler. */
export type * from '@pluxel/host/internal/agent-types'
export {
	createScriptScope,
	ScriptScopeError,
	type ScriptScope,
	type ScriptRevisions,
} from '@pluxel/host/internal/agent/runtime'
