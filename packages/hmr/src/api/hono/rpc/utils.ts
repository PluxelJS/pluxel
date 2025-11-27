// rpc/utils.ts - RPC 工具函数
import * as v from 'valibot'
import type { ConfigSchemaMap } from '../../..'
import type { ConfigPatch, ConfigValidationErrors } from './types'

/** 收集 schema 的默认值（确保返回 JSON 可序列化的值） */
export function collectDefaults(schemaMap?: ConfigSchemaMap): Record<string, unknown> {
	const defaults: Record<string, unknown> = {}
	if (!schemaMap) return defaults
	for (const [key, schema] of Object.entries(schemaMap)) {
		try {
			// 使用 getDefaults（复数）获取 ObjectSchema 中所有属性的默认值
			const value = v.getDefaults(schema as any)
			if (value !== undefined && value !== null) {
				// 通过 JSON 序列化过滤掉不可序列化的值（函数、Symbol、循环引用等）
				defaults[key] = JSON.parse(JSON.stringify(value))
			}
		} catch {
			// 跳过无法序列化的默认值
		}
	}
	return defaults
}

/** 验证配置补丁 */
export function validateConfigPatch(schemaMap: ConfigSchemaMap, patch: ConfigPatch) {
	const errors: ConfigValidationErrors = {}
	const output: Record<string, unknown> = {}

	for (const [configKey, payload] of Object.entries(patch)) {
		const schema = schemaMap[configKey]
		if (!schema) {
			errors[configKey] = {
				_unknown: [{ message: `Unknown config key: ${configKey}`, path: [configKey] }],
			}
			continue
		}

		const parsed = v.safeParse(schema as any, payload)
		if (!parsed.success) {
			const fieldErrors: Record<string, { message: string; path: string[] }[]> = {}
			for (const issue of parsed.issues) {
				const path = (v.getDotPath(issue) ?? '').split('.').filter(Boolean)
				const key = path[0] ?? '_root'
				;(fieldErrors[key] ??= []).push({ message: issue.message, path })
			}
			errors[configKey] = fieldErrors
			continue
		}

		output[configKey] = parsed.output
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
