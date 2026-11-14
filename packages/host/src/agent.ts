/** Portable script SDK. Importing this entry installs no execution backend or transport. */
export type {
	Script,
	ScriptSdk,
	ScriptContext,
	ScriptPlugin,
	ScriptPluginConfig,
	ScriptPluginSnapshot,
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
} from './agent/sdk-results'
export type {
	PluginDescriptor,
	PluginControlNodeAddress,
	PluginTypedNodeAddress,
	PluginConfigInput,
	PluginConfigOutput,
	PluginInstance,
	ScriptLogReadOptions,
} from './agent/control'
