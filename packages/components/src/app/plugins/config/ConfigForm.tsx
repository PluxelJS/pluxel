import { Box, Group, ScrollArea, SegmentedControl, Stack, Text, Tooltip } from '@mantine/core'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ObjectSchema } from 'valibot'
import { getDefaults } from 'valibot'
import { EmptyState } from '../../../components'
import { useNotify } from '../../hooks'
import { useRuntimeTransportClient } from '../../../runtime'
import { type ConfigFormBridge, type ConfigFormState, ConfigTabPanel } from './ConfigTab'
import { ConfigActionDock } from './components/ConfigActionDock'
import { compareSchemaKeys, formatSchemaGroupLabel, splitSchemaKey } from './schemaKey'
import { makeFieldAnchorPrefix, makeSectionAnchorPrefix } from './utils'

export interface ConfigFormProps {
	pluginName: string
	schemas: Record<string, ObjectSchema<any, any>>
	/** 已保存的配置 */
	savedConfig: Record<string, unknown>
	/** schema 默认值 */
	defaults: Record<string, unknown>
	active?: boolean
	activeKey?: string
	onActiveKeyChange?: (key: string) => void
}

type FormBridge = ConfigFormBridge
type FormState = ConfigFormState
type TabValue = Record<string, unknown>
type FieldIssue = { message?: unknown; path?: unknown }
type FieldErrors = Record<string, FieldIssue[]>
type FormLike = {
	setFieldMeta: (fieldName: string, updater: (meta: unknown) => unknown) => void
}

type SaveConfigFailure = {
	ok: false
	code?: string
	message?: string
	errors?: Record<string, unknown>
}

type SaveConfigSuccess = {
	ok: true
	config?: Record<string, unknown>
	defaults?: Record<string, unknown>
	saved?: boolean
}

type SaveConfigResult = SaveConfigFailure | SaveConfigSuccess

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function toRecord(value: unknown): Record<string, unknown> {
	return isRecord(value) ? value : {}
}

function toIssueArray(value: unknown): FieldIssue[] {
	return Array.isArray(value) ? (value as FieldIssue[]) : []
}

export function ConfigForm({
	pluginName,
	schemas,
	savedConfig,
	defaults,
	active = true,
	activeKey: activeKeyProp,
	onActiveKeyChange,
}: ConfigFormProps) {
	const transport = useRuntimeTransportClient()
	const safeSchemas = schemas ?? {}
	const keys = useMemo(() => Object.keys(safeSchemas).sort(compareSchemaKeys), [safeSchemas])
	const [activeKey, setActiveKey] = useState(keys[0] || '')
	const [savedAtMap, setSavedAtMap] = useState<Record<string, number | undefined>>({})
	const [savingAll, setSavingAll] = useState(false)
	const [baselineOverrides, setBaselineOverrides] = useState<Record<string, TabValue>>({})
	const notify = useNotify()
	const scrollHostsRef = useRef<Record<string, HTMLDivElement | null>>({})
	const [scrollHostVersion, setScrollHostVersion] = useState(0)
	const formBridgeRef = useRef<Record<string, FormBridge>>({})
	const [formStates, setFormStates] = useState<Record<string, FormState>>({})
	const markSaved = useCallback((key: string, value: TabValue) => {
		const savedAt = Date.now()
		setSavedAtMap((m) => ({ ...m, [key]: savedAt }))
		setBaselineOverrides((prev) => ({ ...prev, [key]: value }))
	}, [])

	useEffect(() => {
		const next = keys[0] ?? ''
		const prop = typeof activeKeyProp === 'string' && activeKeyProp ? activeKeyProp : ''

		if (prop) {
			if (keys.includes(prop)) {
				setActiveKey(prop)
				return
			}
			if (next && onActiveKeyChange) {
				onActiveKeyChange(next)
			}
		}

		setActiveKey((prev) => {
			if (prev && keys.includes(prev)) return prev
			return next
		})
	}, [activeKeyProp, keys, onActiveKeyChange])

	const schemaItems = useMemo(() => {
		return keys.map((key) => {
			const schema = safeSchemas[key]!
			const schemaDefaults = toRecord(getDefaults(schema))
			const defaultValue = { ...schemaDefaults, ...toRecord(defaults[key]) }
			const savedValue = baselineOverrides[key] ?? toRecord(savedConfig[key])
			return {
				key,
				schema,
				savedValue,
				defaultValue,
				initialValue: { ...defaultValue, ...savedValue },
			}
		})
	}, [safeSchemas, savedConfig, defaults, keys, baselineOverrides])

	const resolvedActiveKey =
		typeof activeKeyProp === 'string' && keys.includes(activeKeyProp) ? activeKeyProp : activeKey

	const hasConfig = schemaItems.length > 0
	const hasMultipleSchemas = schemaItems.length > 1
	const groups = useMemo(() => {
		const byGroup = new Map<string, string[]>()
		for (const key of keys) {
			const group = splitSchemaKey(key).group
			const existing = byGroup.get(group)
			if (existing) existing.push(key)
			else byGroup.set(group, [key])
		}
		const ordered = Array.from(byGroup.entries()).sort((a, b) => a[0].localeCompare(b[0]))
		return ordered.map(([group, groupKeys]) => ({
			group,
			keys: groupKeys.sort(compareSchemaKeys),
		}))
	}, [keys])
	const hasMultipleGroups = groups.length > 1
	const resolvedActiveGroup = useMemo(() => {
		const g = splitSchemaKey(resolvedActiveKey).group
		if (g && groups.some((x) => x.group === g)) return g
		return groups[0]?.group ?? ''
	}, [groups, resolvedActiveKey])
	const activeGroupKeys = useMemo(() => {
		return groups.find((g) => g.group === resolvedActiveGroup)?.keys ?? []
	}, [groups, resolvedActiveGroup])
	const activeGroupHasMultipleSchemas = activeGroupKeys.length > 1

	const registerForm = useCallback((key: string, bridge: FormBridge) => {
		formBridgeRef.current[key] = bridge
		return () => {
			if (formBridgeRef.current[key] === bridge) delete formBridgeRef.current[key]
		}
	}, [])

	const reportState = useCallback((key: string, next: FormState) => {
		setFormStates((prev) => {
			const existing = prev[key]
			if (
				existing &&
				existing.dirty === next.dirty &&
				existing.canSubmit === next.canSubmit &&
				existing.submitting === next.submitting &&
				existing.values === next.values
			) {
				return prev
			}
			return { ...prev, [key]: next }
		})
	}, [])

	const applyFieldErrors = useCallback((form: FormLike, fieldErrors: FieldErrors) => {
		for (const [fieldName, issues] of Object.entries(fieldErrors)) {
			if (fieldName === '_root' || fieldName === '_unknown') continue
			form.setFieldMeta(fieldName, (meta) => {
				const metaObj = toRecord(meta)
				const errorMap = toRecord(metaObj.errorMap)
				const first = issues[0]
				const dotPath = Array.isArray(first?.path) ? (first?.path as unknown[]) : []
				const message = issues
					.map((i) => (typeof i?.message === 'string' ? i.message : String(i?.message ?? '')))
					.filter((x) => x.length > 0)
					.join('; ')
				return {
					...metaObj,
					errorMap: {
						...errorMap,
						onSubmit: { message, dotPath },
					},
				}
			})
		}
	}, [])

	const saveAll = useCallback(async () => {
		if (savingAll || !hasMultipleSchemas) return
		const bridges = formBridgeRef.current
		const patch: Record<string, TabValue> = {}
		for (const item of schemaItems) {
			const bridge = bridges[item.key]
			if (!bridge) continue
			if (!bridge.form?.state?.isDirty) continue
			const values = bridge.form?.state?.values
			patch[item.key] = toRecord(values)
		}

		if (Object.keys(patch).length === 0) {
			notify({ title: '无需提交', message: '没有变更的配置', color: 'blue' })
			return
		}

		setSavingAll(true)
		try {
				const result = (await (transport as any).withRpc((rpc: any) =>
					rpc.plugin(pluginName).saveConfig(patch),
				)) as SaveConfigResult
			if (result.ok === false) {
				if (result.code === 'validation_failed' && result.errors) {
					const errorsByTab = isRecord(result.errors) ? result.errors : {}
					for (const [tabKey, errors] of Object.entries(errorsByTab)) {
						const bridge = bridges[tabKey]
						if (!bridge) continue
						const form = bridge.form as unknown
						if (!isRecord(form) || typeof form.setFieldMeta !== 'function') continue
						const fieldErrors = isRecord(errors) ? errors : {}
						const normalized: FieldErrors = {}
						for (const [fieldName, issues] of Object.entries(fieldErrors)) {
							normalized[fieldName] = toIssueArray(issues)
						}
						applyFieldErrors(form as FormLike, normalized)
					}
				}
				notify({
					title: '提交失败',
					message: result.message ?? result.code ?? '未知错误',
					color: 'red',
				})
				return
			}

			const savedAt = Date.now()
			setSavedAtMap((prev) => {
				const next = { ...prev }
				for (const key of Object.keys(patch)) next[key] = savedAt
				return next
			})
			setBaselineOverrides((prev) => {
				const next = { ...prev }
				for (const [key, value] of Object.entries(patch)) {
					next[key] = value
				}
				return next
			})
			for (const [key, bridge] of Object.entries(bridges)) {
				if (!patch[key]) continue
				bridge.reset(patch[key] ?? {})
			}
			notify({ title: '提交成功', message: '已保存全部配置', color: 'green' })
		} finally {
			setSavingAll(false)
		}
	}, [applyFieldErrors, hasMultipleSchemas, transport, notify, pluginName, savingAll, schemaItems])

	const submitCurrent = useCallback(() => {
		const bridge = formBridgeRef.current[resolvedActiveKey]
		if (!bridge?.submit) return
		bridge.submit()
	}, [resolvedActiveKey])

	const resetCurrent = useCallback(() => {
		const bridge = formBridgeRef.current[resolvedActiveKey]
		const current = schemaItems.find((item) => item.key === resolvedActiveKey)
		if (!bridge || !current) return
		bridge.reset(current.initialValue)
	}, [resolvedActiveKey, schemaItems])

	const resetToDefaults = useCallback(() => {
		const bridge = formBridgeRef.current[resolvedActiveKey]
		const current = schemaItems.find((item) => item.key === resolvedActiveKey)
		if (!bridge || !current) return
		bridge.reset(current.defaultValue)
	}, [resolvedActiveKey, schemaItems])

	const setScrollHost = useCallback((key: string, node: HTMLDivElement | null) => {
		if (!node || scrollHostsRef.current[key] === node) return
		node.dataset.configScrollRoot = 'true'
		scrollHostsRef.current[key] = node
		setScrollHostVersion((v) => v + 1)
	}, [])

	const dirtyKeys = useMemo(() => {
		return schemaItems.filter((item) => formStates[item.key]?.dirty).map((item) => item.key)
	}, [formStates, schemaItems])

	const activeState = formStates[resolvedActiveKey] ?? {
		dirty: false,
		canSubmit: false,
		submitting: false,
		values: {},
	}

	const changedFieldsByKey = useMemo(() => {
		const out: Record<string, string[]> = {}
		for (const item of schemaItems) {
			const current = formStates[item.key]?.values
			if (!current) {
				out[item.key] = []
				continue
			}
			const baseline = item.initialValue
			const keys = new Set([...Object.keys(baseline), ...Object.keys(current)])
			const changed: string[] = []
			for (const key of keys) {
				if (!Object.is(baseline[key], current[key])) changed.push(key)
			}
			out[item.key] = changed
		}
		return out
	}, [formStates, schemaItems])

	const schemaOptions = useMemo(() => {
		const activeSet = new Set(activeGroupKeys)
		return schemaItems
			.filter((item) => activeSet.has(item.key))
			.map((item) => {
				const state = formStates[item.key]
				const dirty = Boolean(state?.dirty)
				const changedFields = changedFieldsByKey[item.key] ?? []
				const savedAt = savedAtMap[item.key]
				const { group, sub } = splitSchemaKey(item.key)
				const displayKey =
					!hasMultipleGroups && group !== '__plugin__'
						? sub === 'config'
							? '配置'
							: sub
						: formatSchemaKeyLabel(item.key)

				const label = (
					<Tooltip
						key={item.key}
						withArrow
						openDelay={300}
						label={
							<Stack gap={4}>
								<Text size="xs" fw={600}>
									{item.key}
								</Text>
								{dirty ? (
									<Text size="xs">
										{changedFields.length > 0
											? `已修改 ${changedFields.length} 项：${formatFieldList(changedFields)}`
											: '已修改'}
									</Text>
								) : savedAt ? (
									<Text size="xs">上次保存：{new Date(savedAt).toLocaleString()}</Text>
								) : (
									<Text size="xs">未修改</Text>
								)}
							</Stack>
						}
					>
						<Group gap={6} wrap="nowrap">
							<Text size="xs">{displayKey}</Text>
							{dirty ? (
								<Box
									style={{
										width: 6,
										height: 6,
										borderRadius: 999,
										background: 'var(--mantine-color-yellow-filled)',
									}}
								/>
							) : null}
						</Group>
					</Tooltip>
				)

				return { value: item.key, label }
			})
	}, [activeGroupKeys, changedFieldsByKey, formStates, hasMultipleGroups, savedAtMap, schemaItems])

	const groupOptions = useMemo(() => {
		if (!hasMultipleGroups) return []
		const keyToDirty = (key: string) => Boolean(formStates[key]?.dirty)
		return groups.map((g) => {
			const dirty = g.keys.some(keyToDirty)
			const label = (
				<Group key={g.group} gap={6} wrap="nowrap">
					<Text size="xs">{formatSchemaGroupLabel(g.group)}</Text>
					{dirty ? (
						<Box
							style={{
								width: 6,
								height: 6,
								borderRadius: 999,
								background: 'var(--mantine-color-yellow-filled)',
							}}
						/>
					) : null}
				</Group>
			)
			return { value: g.group, label }
		})
	}, [formStates, groups, hasMultipleGroups])

	return (
		<Box style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, minWidth: 0 }}>
			{!hasConfig ? (
				<Box style={{ flex: 1, minHeight: 0 }}>
					<EmptyState
						title="暂无可填写的配置"
						description="该插件当前未公开任何配置 schema。"
						icon={null}
						minHeight="auto"
					/>
				</Box>
			) : (
				<Box
					style={{
						display: 'flex',
						flexDirection: 'column',
						flex: 1,
						minHeight: 0,
						overflow: 'hidden',
					}}
				>
					{hasMultipleGroups ? (
						<Group justify="space-between" mb="xs" wrap="nowrap">
							<SegmentedControl
								size="xs"
								radius="xl"
								value={resolvedActiveGroup}
								onChange={(v) => {
									const nextGroup = String(v)
									const nextKey = groups.find((g) => g.group === nextGroup)?.keys?.[0] ?? ''
									if (!nextKey) return
									setActiveKey(nextKey)
									onActiveKeyChange?.(nextKey)
								}}
								data={groupOptions}
							/>
						</Group>
					) : null}

					{(hasMultipleSchemas && activeGroupHasMultipleSchemas) ||
					(!hasMultipleGroups && hasMultipleSchemas) ? (
						<Group justify="space-between" mb="xs" wrap="nowrap">
							<SegmentedControl
								size="xs"
								radius="xl"
								value={resolvedActiveKey}
								onChange={(v) => {
									const nextKey = String(v)
									setActiveKey(nextKey)
									onActiveKeyChange?.(nextKey)
								}}
								data={schemaOptions}
							/>
						</Group>
					) : null}

					{schemaItems.map(({ key, schema, savedValue, defaultValue }) => {
						const isActive = key === resolvedActiveKey
						const showOverlay = active && isActive
						return (
							<ScrollArea
								key={`${pluginName}-${key}`}
								type="auto"
								scrollbarSize={10}
								offsetScrollbars
								style={{
									display: isActive ? 'block' : 'none',
									flex: 1,
									minHeight: 0,
								}}
								viewportRef={(node) => setScrollHost(key, node)}
							>
								<ConfigTabPanel
									pluginName={pluginName}
									tabKey={key}
									schema={schema}
									savedValue={savedValue}
									defaultValue={defaultValue}
									onSaved={markSaved}
									showToc={showOverlay}
									active={showOverlay}
									sectionIdPrefix={makeSectionAnchorPrefix(pluginName, key)}
									fieldIdPrefix={makeFieldAnchorPrefix(pluginName, key)}
									scrollHost={scrollHostsRef.current[key]}
									scrollHostVersion={scrollHostVersion}
									registerForm={registerForm}
									reportState={reportState}
								/>
							</ScrollArea>
						)
					})}
				</Box>
			)}
			{active && hasConfig ? (
				<ConfigActionDock
					activeKey={resolvedActiveKey}
					activeState={activeState}
					activeSavedAt={savedAtMap[resolvedActiveKey]}
					dirtyKeys={dirtyKeys}
					hasMultipleSchemas={hasMultipleSchemas}
					savingAll={savingAll}
					onSubmitCurrent={submitCurrent}
					onSubmitAll={saveAll}
					onResetCurrent={resetCurrent}
					onResetDefaults={resetToDefaults}
				/>
			) : null}
		</Box>
	)
}

function formatFieldList(fields: string[], limit = 4) {
	if (fields.length <= limit) return fields.join(', ')
	return `${fields.slice(0, limit).join(', ')} +${fields.length - limit}`
}

function formatSchemaKeyLabel(key: string): string {
	const dot = key.indexOf('.')
	if (dot === -1) return key
	const head = key.slice(0, dot)
	const tail = key.slice(dot + 1)
	if (!head || !tail) return key
	if (tail === 'config') return head
	return `${head}:${tail}`
}
