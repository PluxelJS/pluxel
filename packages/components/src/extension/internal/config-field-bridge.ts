import { useEffect, useMemo, useState } from 'react'
import { useGlobalExtensionContext } from '@pluxel/runtime/web'
import { usePluginConfig } from '../../app/hooks/usePluginConfig'

export function readString(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

export function readNested(source: unknown, path: string): unknown {
	if (!source || typeof source !== 'object') return undefined
	let current: unknown = source
	for (const segment of path.split('.')) {
		const key = segment.trim()
		if (!key || !current || typeof current !== 'object') return undefined
		current = (current as Record<string, unknown>)[key]
	}
	return current
}

export function writeNested(
	source: Record<string, unknown>,
	path: string,
	value: unknown,
): Record<string, unknown> {
	const segments = path
		.split('.')
		.map((segment) => segment.trim())
		.filter(Boolean)
	if (segments.length === 0) return source

	const out: Record<string, unknown> = { ...source }
	let cursor: Record<string, unknown> = out
	for (let i = 0; i < segments.length - 1; i += 1) {
		const key = segments[i]!
		const next =
			cursor[key] && typeof cursor[key] === 'object' && !Array.isArray(cursor[key])
				? { ...(cursor[key] as Record<string, unknown>) }
				: {}
		cursor[key] = next
		cursor = next
	}
	cursor[segments[segments.length - 1]!] = value
	return out
}

export type ConfigFieldBridge = {
	config: ReturnType<typeof usePluginConfig>
	loading: boolean
	error?: Error
	saving: boolean
	schemaExists: boolean
	currentSchemaValue: Record<string, unknown>
	fieldValue: unknown
	saveFieldValue: (value: unknown) => Promise<Record<string, unknown>>
}

export function useConfigFieldBridge(input: {
	targetPlugin: string
	schemaKey: string
	fieldPath: string
}): ConfigFieldBridge {
	const { targetPlugin, schemaKey, fieldPath } = input
	const ctx = useGlobalExtensionContext()
	const transport = ctx.services.transport
	const config = usePluginConfig(targetPlugin)
	const [saving, setSaving] = useState(false)
	const [savedOverride, setSavedOverride] = useState<Record<string, unknown> | null>(null)

	useEffect(() => {
		setSavedOverride(null)
	}, [targetPlugin, config.data?.savedConfig])

	const schemaMap = (config.data?.schemaMap ?? {}) as Record<string, unknown>
	const defaults = (config.data?.defaults ?? {}) as Record<string, Record<string, unknown>>
	const savedConfig = (savedOverride ?? config.data?.savedConfig ?? {}) as Record<
		string,
		Record<string, unknown>
	>

	const currentSchemaValue = useMemo(() => {
		const defaultSchemaValue = defaults?.[schemaKey] as Record<string, unknown> | undefined
		const savedSchemaValue = savedConfig?.[schemaKey] as Record<string, unknown> | undefined
		return {
			...defaultSchemaValue,
			...savedSchemaValue,
		}
	}, [defaults, savedConfig, schemaKey])

	const fieldValue = useMemo(
		() => readNested(currentSchemaValue, fieldPath),
		[currentSchemaValue, fieldPath],
	)

	return {
		config,
		loading: config.loading,
		error: config.error,
		saving,
		schemaExists: Boolean(schemaKey && schemaMap[schemaKey]),
		currentSchemaValue,
		fieldValue,
		async saveFieldValue(value: unknown) {
			const nextSchemaValue = writeNested(currentSchemaValue, fieldPath, value)

			setSaving(true)
			try {
				const result: any = await transport.withRpc((rpc: any) =>
					rpc.plugin(targetPlugin).saveConfigField({
						schemaKey,
						fieldPath,
						value,
					}),
				)
				if (!result || result.ok === false) {
					throw new Error(result?.message ?? result?.code ?? 'save_config_failed')
				}
				const nextSavedConfig =
					result && result.ok === true && result.config && typeof result.config === 'object'
						? (result.config as Record<string, unknown>)
						: ({
								...((savedConfig ?? {}) as Record<string, unknown>),
								[schemaKey]: nextSchemaValue,
							} as Record<string, unknown>)
				setSavedOverride(nextSavedConfig)
				return nextSavedConfig
			} finally {
				setSaving(false)
			}
		},
	}
}
