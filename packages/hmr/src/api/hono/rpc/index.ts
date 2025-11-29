// rpc/index.ts - RPC 模块导出
export { HmrRpcApi } from './HmrRpcApi'
export { PluginHandle } from './PluginHandle'
export type {
	ConfigPatch,
	ConfigResult,
	ConfigResultErr,
	ConfigResultOk,
	ConfigValidationErrors,
	GroupMutationResult,
	PluginStatusAction,
	SchemaResult,
	SchemaResultErr,
	SchemaResultOk,
} from './types'
export { collectDefaults, formatGroupIssues, validateConfigPatch } from './utils'
