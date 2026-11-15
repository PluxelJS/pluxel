/** Custom Host execution and control-plane integration. The caller owns and drains each scope/executor. */
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
