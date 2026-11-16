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
	ScriptErrorDetails,
} from './agent/sdk-outcomes'
export type {
	PluginDescriptor,
	PluginControlNodeAddress,
	PluginTypedNodeAddress,
	PluginConfigInput,
	PluginConfigOutput,
	PluginInstance,
} from './agent/control'
