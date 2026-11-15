/** Portable script SDK. Importing this entry installs no execution backend or transport. */
export type {
	Script,
	ScriptSdk,
	ScriptContext,
	ScriptPlugin,
	ScriptPluginConfig,
	ScriptPluginSnapshot,
	ScriptPluginListOptions,
	ScriptPluginListError,
	ScriptPluginInspect,
	ScriptInspectionOptions,
} from './agent/sdk-types'
export type {
	ScriptRunError,
	ScriptOperationError,
	ScriptTargetError,
	ScriptControlError,
	ScriptConfigSnapshot,
	ScriptConfigError,
	ScriptPolicySnapshot,
	ScriptPolicyError,
	ScriptInstanceError,
	ScriptLifecycleError,
	ScriptLogSnapshot,
	ScriptLogError,
	ScriptInspectionError,
} from './agent/sdk-results'
export type {
	PluginDescriptor,
	PluginControlNodeAddress,
	PluginTypedNodeAddress,
	PluginConfigInput,
	PluginConfigOutput,
	PluginInstance,
} from './agent/control'
/** Detached source-query data; this entry loads no compiler or filesystem backend. */
export type * from './agent/inspection'
