// rpc/utils.ts - RPC 工具函数
import * as v from 'valibot'
import type { ConfigSchemaMap } from '../../..'
import type { ConfigPatch, ConfigValidationErrors } from './types'

/** 检测 schemaMap 中是否存在异步 schema */
function hasAsyncSchema(schemaMap: ConfigSchemaMap): boolean {
	return Object.values(schemaMap).some((s) => s.async)
}

/** 安全序列化值（过滤不可序列化内容） */
function safeSerialize(value: unknown): unknown {
	if (value === undefined || value === null) return undefined
	try {
		return JSON.parse(JSON.stringify(value))
	} catch {
		return undefined
	}
}

/** 收集 schema 的默认值（确保返回 JSON 可序列化的值） */
export async function collectDefaults(
	schemaMap?: ConfigSchemaMap,
): Promise<Record<string, unknown>> {
	if (!schemaMap) return {}
	const entries = Object.entries(schemaMap)
	if (entries.length === 0) return {}

	// 快速同步路径：所有 schema 都是同步的
	if (!hasAsyncSchema(schemaMap)) {
		const defaults: Record<string, unknown> = {}
		for (const [key, schema] of entries) {
			const value = safeSerialize(v.getDefaults(schema as any))
			if (value !== undefined) defaults[key] = value
		}
		return defaults
	}

	// 异步路径：并行处理
	const results = await Promise.all(
		entries.map(async ([key, schema]) => {
			const raw = schema.async
				? await v.getDefaultsAsync(schema as any)
				: v.getDefaults(schema as any)
			return [key, safeSerialize(raw)] as const
		}),
	)
	return Object.fromEntries(results.filter(([, v]) => v !== undefined))
}

/** 解析单个 schema 的验证结果 */
function parseValidationResult(
	configKey: string,
	parsed: v.SafeParseResult<any>,
	errors: ConfigValidationErrors,
	output: Record<string, unknown>,
): void {
	if (!parsed.success) {
		const fieldErrors: Record<string, { message: string; path: string[] }[]> = {}
		for (const issue of parsed.issues) {
			const path = (v.getDotPath(issue) ?? '').split('.').filter(Boolean)
			const key = path[0] ?? '_root'
			;(fieldErrors[key] ??= []).push({ message: issue.message, path })
		}
		errors[configKey] = fieldErrors
		return
	}
	output[configKey] = parsed.output
}

/** 验证配置补丁 */
export async function validateConfigPatch(schemaMap: ConfigSchemaMap, patch: ConfigPatch) {
	const errors: ConfigValidationErrors = {}
	const output: Record<string, unknown> = {}
	const entries = Object.entries(patch)

	// 先处理未知 key
	const validEntries: [string, unknown, ConfigSchemaMap[string]][] = []
	for (const [configKey, payload] of entries) {
		const schema = schemaMap[configKey]
		if (!schema) {
			errors[configKey] = {
				_unknown: [{ message: `Unknown config key: ${configKey}`, path: [configKey] }],
			}
			continue
		}
		validEntries.push([configKey, payload, schema])
	}

	if (validEntries.length === 0) {
		if (Object.keys(errors).length > 0) return { ok: false as const, errors }
		return { ok: true as const, output }
	}

	// 快速同步路径：所有涉及的 schema 都是同步的
	const hasAsync = validEntries.some(([, , schema]) => schema.async)
	if (!hasAsync) {
		for (const [configKey, payload, schema] of validEntries) {
			const parsed = v.safeParse(schema as any, payload)
			parseValidationResult(configKey, parsed, errors, output)
		}
	} else {
		// 异步路径：并行处理
		const results = await Promise.all(
			validEntries.map(async ([configKey, payload, schema]) => {
				const parsed = schema.async
					? await v.safeParseAsync(schema as any, payload)
					: v.safeParse(schema as any, payload)
				return [configKey, parsed] as const
			}),
		)
		for (const [configKey, parsed] of results) {
			parseValidationResult(configKey, parsed, errors, output)
		}
	}

	if (Object.keys(errors).length > 0) return { ok: false as const, errors }
	return { ok: true as const, output }
}

/** 格式化 valibot issues 为 ConfigValidationErrors */
export function formatGroupIssues(issues: readonly any[]): ConfigValidationErrors {
	const errors: ConfigValidationErrors = {}
	for (const issue of issues) {
		const path = (v.getDotPath(issue) ?? '').split('.').filter(Boolean)
		const key = path[0] ?? '_root'
		;(errors[key] ??= { _root: [] })._root.push({ message: issue.message, path })
	}
	return errors
}
