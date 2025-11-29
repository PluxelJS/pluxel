// rpc/types.ts - RPC 类型定义

export type PluginStatusAction = 'start' | 'stop' | 'restart' | 'enable' | 'disable'
export type ConfigPatch = Record<string, unknown>
export type ConfigValidationErrors = Record<string, Record<string, { message: string; path: string[] }[]>>

export type ConfigResultOk = {
	ok: true
	config: Record<string, unknown>
	defaults: Record<string, unknown>
	saved?: boolean
}

export type ConfigResultErr = {
	ok: false
	code: 'config_not_found' | 'validation_failed'
	message?: string
	errors?: ConfigValidationErrors
	defaults?: Record<string, unknown>
}

export type ConfigResult = ConfigResultOk | ConfigResultErr

export type SchemaResultOk = {
	ok: true
	schemaSource: Record<string, string>
	defaults: Record<string, unknown>
}

export type SchemaResultErr = {
	ok: false
	code: 'plugin_not_found' | 'schema_not_found'
	message: string
}

export type SchemaResult = SchemaResultOk | SchemaResultErr

export type GroupMutationResult =
	| { ok: true; groups: unknown }
	| { ok: false; code: 'validation_failed'; errors: ConfigValidationErrors }

// Market 相关类型
export type PackageSpecInput = {
	raw?: string | null
	name?: string | null
	version?: string | null
	tag?: string | null
}

export type MarketMutationResult = {
	__typename: 'PackageMutationResult'
	ok: boolean
	code: string
	spec: {
		__typename: 'PackageIssueSpec'
		name: string
		version: string | null
		tag: string | null
		target: string
		raw: string
	} | null
	installStatus: 'installed' | 'reused' | null
	error: string | null
}

export type MarketBatchResult = {
	__typename: 'PackageBatchMutationResult'
	ok: boolean
	results: MarketMutationResult[]
	error: string | null
}
