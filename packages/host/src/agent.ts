/** Portable script SDK. Importing this entry installs no execution backend or transport. */
export type { Script, ScriptSdk, ScriptContext } from './agent/sdk-types'
export type {
	PluginDescriptor,
	PluginTypedTarget,
	PluginTarget,
	PluginConfigInput,
	PluginConfigOutput,
	PluginInstance,
	ScriptLogReadOptions,
} from './agent/control'
export {
	parsePluginControlDescriptor,
	parsePluginControlManifest,
	verifyPluginControlMaterial,
	verifyPluginControlMaterialSync,
	renderPluginDescriptors,
	encodeControlData,
	isControlFilePath,
	controlSha256,
	type PluginControlDescriptorData,
	type PluginControlManifest,
} from './control-manifest'
export {
	readPluginControlMaterials,
	createPluginControlMaterialReader,
	parsePluginControlManifestIndex,
	parsePluginControlManifestRequest,
	parsePluginControlFileRequest,
	parsePluginControlFileChunk,
	PLUGIN_CONTROL_CHUNK_BYTES,
	PLUGIN_CONTROL_CACHE_MS,
	type PluginControlMaterialsSnapshot,
	type PluginControlManifestIndex,
	type PluginControlManifestRequest,
	type PluginControlFileRequest,
	type PluginControlFileChunk,
	type PluginControlMaterialReader,
} from './agent/materials'
export {
	createScriptScope,
	ScriptScopeError,
	type ScriptScope,
	type ScriptRevisions,
} from './agent/sdk'
export {
	SCRIPT_PROTOCOL,
	SCRIPT_ARTIFACT_FORMAT,
	SCRIPT_VALUE_BYTES,
	SCRIPT_DEFAULT_TIMEOUT,
	SCRIPT_MAX_TIMEOUT,
	ScriptExecutionError,
	scriptFailure,
	snapshotJson,
	hashScriptSource,
	scriptRequestHash,
	isScriptFinished,
	type JsonValue,
	type ScriptCode,
	type ScriptProjectCode,
	type ScriptArtifact,
	type ScriptSubmission,
	type ScriptControlSubmission,
	type ScriptHmrAction,
	type ScriptPhase,
	type ScriptFailure,
	type ScriptRunSnapshot,
} from './agent/protocol'
export { ScriptExecutor, type ScriptExecutorOptions, type RunExecution } from './agent/runtime'
export { executeHostScript } from './agent/execute'
