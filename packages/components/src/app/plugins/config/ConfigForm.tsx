import { Box, ScrollArea } from '@mantine/core'
import { useHotkeys } from '@mantine/hooks'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getDefaults, type ObjectSchema } from 'valibot'
import { EmptyState } from '../../../components'
import { SegmentedButtons } from 'valibot-form/web'
import { useNotify } from '../../hooks/useNotify'
import { commitPluginConfig } from './usePluginConfig'
import { patchPluginConfig, useRuntimeTransportClient, type ConfigResult } from '../../../runtime'
import { PLUGIN_DETAIL_HOTKEYS } from '../../workbench/shortcuts'
import { type ConfigFormBridge, type ConfigFormState, ConfigTabPanel } from './ConfigTab'
import { ConfigActionDock } from './components/ConfigActionDock'
import { compareSchemaKeys, formatSchemaGroupLabel, splitSchemaKey } from './schemaKey'
import { makeFieldAnchorPrefix, makeSectionAnchorPrefix } from './configAnchors'

export interface ConfigFormProps {
	pluginName: string
	schemas: Record<string, ObjectSchema<any, any>>
	/** 已保存的配置 */
	savedConfig: Record<string, unknown>
	/** schema 默认值 */
	defaults: Record<string, unknown>
	active?: boolean
	activeKey?: string
	draftValues?: Record<string, Record<string, unknown>>
	onActiveKeyChange?: (key: string) => void
	onDirtyChange?: (dirty: boolean) => void
	onDraftChange?: (drafts: Record<string, Record<string, unknown>>) => void
}

type FormBridge = ConfigFormBridge
type FormState = ConfigFormState
type TabValue = Record<string, unknown>
type FieldIssue = { message?: unknown; path?: unknown }
type FieldErrors = Record<string, FieldIssue[]>
type FormLike = {
	setFieldMeta: (fieldName: string, updater: (meta: unknown) => unknown) => void
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function toRecord(value: unknown): Record<string, unknown> {
	return isRecord(value) ? value : {}
}

function deepEqual(a: unknown, b: unknown): boolean {
	if (Object.is(a, b)) return true
	if (Array.isArray(a) && Array.isArray(b)) {
		if (a.length !== b.length) return false
		for (let i = 0; i < a.length; i += 1) {
			if (!deepEqual(a[i], b[i])) return false
		}
		return true
	}
	if (isRecord(a) && isRecord(b)) {
		const aKeys = Object.keys(a)
		const bKeys = Object.keys(b)
		if (aKeys.length !== bKeys.length) return false
		for (const key of aKeys) {
			if (!(key in b)) return false
			if (!deepEqual(a[key], b[key])) return false
		}
		return true
	}
	return false
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
	draftValues,
	onActiveKeyChange,
	onDirtyChange,
	onDraftChange,
}: ConfigFormProps) {
	const transport = useRuntimeTransportClient()
	const safeSchemas = schemas ?? {}
	const keys = useMemo(() => Object.keys(safeSchemas).sort(compareSchemaKeys), [safeSchemas])
	const [activeKey, setActiveKey] = useState(keys[0] || '')
	const [savedAtMap, setSavedAtMap] = useState<Record<string, number | undefined>>({})
	const [savingAll, setSavingAll] = useState(false)
	const notify = useNotify()
	const scrollHostsRef = useRef<Record<string, HTMLDivElement | null>>({})
	const [scrollHostVersion, setScrollHostVersion] = useState(0)
	const formBridgeRef = useRef<Record<string, FormBridge>>({})
	const [formStates, setFormStates] = useState<Record<string, FormState>>({})
	const formStatesRef = useRef<Record<string, FormState>>({})
	const lastDraftsRef = useRef<Record<string, Record<string, unknown>>>({})
	const configIdentityRef = useRef('')
	const markSaved = useCallback((key: string) => {
		const savedAt = Date.now()
		setSavedAtMap((m) => ({ ...m, [key]: savedAt }))
	}, [])
	const configIdentity = useMemo(() => `${pluginName}\n${keys.join('\n')}`, [keys, pluginName])

	useEffect(() => {
		if (configIdentityRef.current === configIdentity) return
		configIdentityRef.current = configIdentity
		formBridgeRef.current = {}
		formStatesRef.current = {}
		lastDraftsRef.current = {}
		setSavedAtMap({})
		setFormStates({})
	}, [configIdentity])

	useEffect(() => {
		const keySet = new Set(keys)
		setSavedAtMap((prev) => {
			const next = Object.fromEntries(
				Object.entries(prev).filter(([key]) => keySet.has(key)),
			) as Record<string, number | undefined>
			return deepEqual(prev, next) ? prev : next
		})
		setFormStates((prev) => {
			const next = Object.fromEntries(
				Object.entries(prev).filter(([key]) => keySet.has(key)),
			) as Record<string, FormState>
			formStatesRef.current = next
			return deepEqual(prev, next) ? prev : next
		})
	}, [keys, savedConfig])

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
			const savedValue = toRecord(savedConfig[key])
			return {
				key,
				schema,
				savedValue,
				defaultValue,
				initialValue: { ...defaultValue, ...savedValue },
			}
		})
	}, [safeSchemas, savedConfig, defaults, keys])

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
				deepEqual(existing.values, next.values)
			) {
				return prev
			}
			const updated = { ...prev, [key]: next }
			formStatesRef.current = updated
			return updated
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
			const result = (await transport.withRpc((rpc) =>
				patchPluginConfig(rpc, pluginName, patch),
			)) as ConfigResult
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

			commitPluginConfig(pluginName, result.config)
			const savedAt = Date.now()
			setSavedAtMap((prev) => {
				const next = { ...prev }
				for (const key of Object.keys(patch)) next[key] = savedAt
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

	useEffect(() => {
		onDirtyChange?.(dirtyKeys.length > 0)
	}, [dirtyKeys.length, onDirtyChange])

	useEffect(() => {
		const nextDrafts: Record<string, Record<string, unknown>> = {}
		for (const [key, state] of Object.entries(formStates)) {
			if (!state?.dirty) continue
			nextDrafts[key] = toRecord(state.values)
		}
		if (!onDraftChange) return undefined
		if (deepEqual(lastDraftsRef.current, nextDrafts)) return undefined
		const handle = window.setTimeout(() => {
			lastDraftsRef.current = nextDrafts
			onDraftChange(nextDrafts)
		}, 120)
		return () => window.clearTimeout(handle)
	}, [formStates, onDraftChange])

	const activeState = formStates[resolvedActiveKey] ?? {
		dirty: false,
		canSubmit: false,
		submitting: false,
		values: {},
	}
	const showSchemaSwitcher =
		(hasMultipleSchemas && activeGroupHasMultipleSchemas) ||
		(!hasMultipleGroups && hasMultipleSchemas)

	const schemaOptions = useMemo(() => {
		const activeSet = new Set(activeGroupKeys)
		return schemaItems
			.filter((item) => activeSet.has(item.key))
			.map((item) => {
				const state = formStates[item.key]
				const dirty = Boolean(state?.dirty)
				const savedAt = savedAtMap[item.key]
				const { group, sub } = splitSchemaKey(item.key)
				const displayKey =
					!hasMultipleGroups && group !== '__plugin__'
						? sub === 'config'
							? '配置'
							: sub
						: formatSchemaKeyLabel(item.key)
				const statusSuffix = dirty ? ' •' : savedAt ? '' : ''

				return { value: item.key, label: `${displayKey}${statusSuffix}` }
			})
	}, [activeGroupKeys, formStates, hasMultipleGroups, savedAtMap, schemaItems])

	const groupOptions = useMemo(() => {
		if (!hasMultipleGroups) return []
		const keyToDirty = (key: string) => Boolean(formStates[key]?.dirty)
		return groups.map((g) => {
			const dirty = g.keys.some(keyToDirty)
			return {
				value: g.group,
				label: `${formatSchemaGroupLabel(g.group)}${dirty ? ' •' : ''}`,
			}
		})
	}, [formStates, groups, hasMultipleGroups])

	useHotkeys(
		active && hasMultipleSchemas
			? [
					[
						PLUGIN_DETAIL_HOTKEYS.saveAllConfig,
						(event: KeyboardEvent) => {
							event.preventDefault()
							void saveAll()
						},
					],
				]
			: [],
	)

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
					{hasMultipleGroups || showSchemaSwitcher || active ? (
						<Box className="plx-pluginWorkbench__configToolbar">
							<div className="plx-pluginWorkbench__configToolbarNav">
								{hasMultipleGroups ? (
									<div className="plx-pluginWorkbench__configToolbarScroller">
										<SegmentedButtons
											size="xs"
											value={resolvedActiveGroup}
											onChange={(v) => {
												const nextGroup = String(v)
												const nextKey = groups.find((g) => g.group === nextGroup)?.keys?.[0] ?? ''
												if (!nextKey) return
												setActiveKey(nextKey)
												onActiveKeyChange?.(nextKey)
											}}
											data={groupOptions}
											fullWidth={false}
										/>
									</div>
								) : null}

								{hasMultipleGroups && showSchemaSwitcher ? (
									<div aria-hidden="true" className="plx-pluginWorkbench__configToolbarDivider" />
								) : null}

								{showSchemaSwitcher ? (
									<div className="plx-pluginWorkbench__configToolbarScroller">
										<SegmentedButtons
											size="xs"
											value={resolvedActiveKey}
											onChange={(v) => {
												const nextKey = String(v)
												setActiveKey(nextKey)
												onActiveKeyChange?.(nextKey)
											}}
											data={schemaOptions}
											fullWidth={false}
										/>
									</div>
								) : null}
							</div>

							{active ? (
								<ConfigActionDock
									activeKey={resolvedActiveKey}
									activeState={activeState}
									activeSavedAt={savedAtMap[resolvedActiveKey]}
									dirtyKeys={dirtyKeys}
									hasMultipleSchemas={hasMultipleSchemas}
									savingAll={savingAll}
									schemaOptions={showSchemaSwitcher ? schemaOptions : []}
									onActiveKeyChange={(nextKey) => {
										setActiveKey(nextKey)
										onActiveKeyChange?.(nextKey)
									}}
									onSubmitCurrent={submitCurrent}
									onSubmitAll={saveAll}
									onResetCurrent={resetCurrent}
									onResetDefaults={resetToDefaults}
								/>
							) : null}
						</Box>
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
									draftValue={toRecord(draftValues?.[key])}
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
		</Box>
	)
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
