import { makePathArray } from '@tanstack/react-form'
import { Box, ScrollArea } from '@mantine/core'
import { useHotkeys } from '@mantine/hooks'
import type { PluginNodeAddress } from '@pluxel/core'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { FieldNode } from 'valibot-form'

import { useRuntimeManagementClient } from '../../../runtime'
import { useNotify } from '../../hooks/useNotify'
import { PLUGIN_DETAIL_HOTKEYS } from '../../workbench/shortcuts'
import { refreshPluginReadModels } from '../pluginReadModels'
import { type ConfigFormBridge, type ConfigFormState, ConfigTabContent } from './ConfigTab'
import { ConfigActionDock } from './components/ConfigActionDock'
import { buildEditableConfigPatch } from './presentationAdapter'
import {
	commitPluginConfig,
	refreshPluginConfig,
	type PluginConfigSection,
} from './usePluginConfig'
import { mapConfigValidationErrors, mountedFieldNames } from '../../forms/serverValidation'

const EMPTY_CONFIG_SECTIONS: readonly PluginConfigSection[] = []
const EMPTY_FORM_STATE: ConfigFormState = {
	dirty: false,
	canSubmit: false,
	submitting: false,
	values: {},
}

type ConfigFormProps = {
	owner: PluginNodeAddress
	displayName: string
	fields: readonly FieldNode[]
	savedConfig: Record<string, unknown>
	defaults: Record<string, unknown>
	active?: boolean
	onDirtyChange?: (dirty: boolean) => void
	sections?: readonly PluginConfigSection[]
}

type SectionItem = {
	key: string
	label: string
	path: readonly string[]
	fields: readonly FieldNode[]
	defaultValue: Record<string, unknown>
	savedValue: Record<string, unknown>
	initialValue: Record<string, unknown>
}

export function ConfigForm(props: ConfigFormProps) {
	const sections = props.sections ?? EMPTY_CONFIG_SECTIONS
	const identity = `${JSON.stringify(props.owner)}\0${(sections.length > 0
		? sections
		: [{ path: [] }]
	)
		.map((section) => section.path.join('.'))
		.join('\0')}`
	return <ConfigFormInstance key={identity} {...props} sections={sections} />
}

function ConfigFormInstance({
	owner,
	displayName,
	fields,
	savedConfig,
	defaults,
	active = true,
	onDirtyChange,
	sections,
}: ConfigFormProps & { sections: readonly PluginConfigSection[] }) {
	const management = useRuntimeManagementClient()
	const queryClient = useQueryClient()
	const notify = useNotify()
	const visibleSections = useMemo<readonly PluginConfigSection[]>(
		() => (sections.length > 0 ? sections : [{ path: [], fields, defaults, fieldName: '' }]),
		[defaults, fields, sections],
	)
	const sectionItems = useMemo<SectionItem[]>(
		() =>
			visibleSections.map((section) => {
				const savedValue = recordAtPath(savedConfig, section.path)
				return {
					key: sectionKey(section.path),
					label: sectionLabel(section.path),
					path: section.path,
					fields: section.fields,
					defaultValue: section.defaults,
					savedValue,
					initialValue: { ...section.defaults, ...savedValue },
				}
			}),
		[savedConfig, visibleSections],
	)
	const [activeKey, setActiveKey] = useState(sectionItems[0]?.key ?? '')
	const [formStates, setFormStates] = useState<Record<string, ConfigFormState>>({})
	const [savingAll, setSavingAll] = useState(false)
	const formBridgesRef = useRef<Record<string, ConfigFormBridge>>({})

	useEffect(() => {
		if (sectionItems.some((section) => section.key === activeKey)) return
		setActiveKey(sectionItems[0]?.key ?? '')
	}, [activeKey, sectionItems])

	const registerForm = useCallback((key: string, bridge: ConfigFormBridge) => {
		formBridgesRef.current[key] = bridge
		return () => {
			if (formBridgesRef.current[key] === bridge) delete formBridgesRef.current[key]
		}
	}, [])

	const reportState = useCallback((key: string, state: ConfigFormState) => {
		setFormStates((current) => {
			const previous = current[key]
			if (previous && sameFormState(previous, state)) return current
			return { ...current, [key]: state }
		})
	}, [])

	const dirtyKeys = useMemo(
		() =>
			sectionItems
				.filter((section) => formStates[section.key]?.dirty)
				.map((section) => section.key),
		[formStates, sectionItems],
	)
	const dirtyLabels = useMemo(
		() =>
			sectionItems
				.filter((section) => formStates[section.key]?.dirty)
				.map((section) => section.label),
		[formStates, sectionItems],
	)
	const activeSection = sectionItems.find((section) => section.key === activeKey) ?? sectionItems[0]
	const resolvedActiveKey = activeSection?.key ?? ''
	const activeState = formStates[resolvedActiveKey] ?? EMPTY_FORM_STATE
	const canSaveAll = dirtyKeys.every((key) => {
		const state = formStates[key]
		return Boolean(state?.canSubmit && !state.submitting)
	})

	useEffect(() => {
		onDirtyChange?.(dirtyKeys.length > 0)
	}, [dirtyKeys.length, onDirtyChange])

	const submitCurrent = useCallback(() => {
		if (!activeState.dirty || !activeState.canSubmit || activeState.submitting || savingAll) return
		formBridgesRef.current[resolvedActiveKey]?.submit()
	}, [activeState, resolvedActiveKey, savingAll])

	const resetCurrent = useCallback(() => {
		if (activeState.submitting || savingAll) return
		const bridge = formBridgesRef.current[resolvedActiveKey]
		if (!bridge || !activeSection) return
		bridge.reset(activeSection.initialValue)
	}, [activeSection, activeState.submitting, resolvedActiveKey, savingAll])

	const resetToDefaults = useCallback(() => {
		if (activeState.submitting || savingAll) return
		const bridge = formBridgesRef.current[resolvedActiveKey]
		if (!bridge || !activeSection) return
		// Restoring defaults replaces the editable draft as a whole.
		bridge.form.setErrorMap({ onServer: { fields: {} } } as never)
		const editableDefaults = buildEditableConfigPatch(
			activeSection.fields,
			activeSection.defaultValue,
			activeSection.initialValue,
		)
		for (const [key, value] of Object.entries(editableDefaults)) {
			// Defaults contain literal root keys, not TanStack path expressions.
			const parsed = makePathArray(key)
			if (!key || parsed.length !== 1 || parsed[0] !== key) continue
			bridge.form.setFieldValue(key, value)
		}
	}, [activeSection, activeState.submitting, resolvedActiveKey, savingAll])

	const saveAll = useCallback(async () => {
		if (savingAll || dirtyKeys.length === 0 || !canSaveAll) return
		const dirtySet = new Set(dirtyKeys)
		const patch = buildCombinedConfigPatch(savedConfig, sectionItems, formStates, dirtySet)
		if (Object.keys(patch).length === 0) return

		// Capture every section: validation can depend on values outside a reported field.
		const submitted = Object.entries(formBridgesRef.current).map(([key, bridge]) => ({
			key,
			bridge,
			values: bridge.form.state.values,
		}))
		const unchanged = () =>
			submitted.every(
				({ key, bridge, values }) =>
					formBridgesRef.current[key]?.form === bridge.form && bridge.form.state.values === values,
			)
		setSavingAll(true)
		for (const bridge of Object.values(formBridgesRef.current)) {
			bridge.form.setErrorMap({ onServer: { fields: {} } } as never)
		}
		try {
			const result = await management.config.patch(owner, patch)
			if (result.ok === false) {
				if (result.code === 'validation_failed' && unchanged()) {
					for (const section of sectionItems) {
						const bridge = formBridgesRef.current[section.key]
						if (bridge)
							bridge.form.setErrorMap({
								onServer: mapConfigValidationErrors(
									result.errors,
									mountedFieldNames(bridge.form),
									section.path,
								),
							} as never)
					}
				}
				if (result.state === 'unknown') {
					await Promise.all([
						refreshPluginConfig(queryClient, owner),
						refreshPluginReadModels(queryClient),
					])
				}
				notify({
					title: '全部保存失败',
					message: result.message ?? result.code ?? '未知错误',
					color: 'red',
				})
				return
			}

			commitPluginConfig(queryClient, owner, result.config)
			await refreshPluginReadModels(queryClient)
			for (const { key, bridge, values } of submitted) {
				if (dirtySet.has(key) && formBridgesRef.current[key]?.form === bridge.form) {
					bridge.acceptSaved(values)
				}
			}
			if (result.application === 'saved-not-applied') {
				notify({
					title: '配置已保存，但尚未应用',
					message:
						result.saved === true ? result.applyFailure.message : '运行中的插件尚未应用当前配置。',
					color: 'yellow',
				})
			} else {
				notify({
					title: '全部保存成功',
					message:
						result.application === 'deferred'
							? '配置已保存，将在插件启动时应用'
							: `已保存 ${dirtyKeys.length} 个配置分区`,
					color: 'green',
				})
			}
		} catch (cause) {
			await Promise.allSettled([
				refreshPluginConfig(queryClient, owner),
				refreshPluginReadModels(queryClient),
			])
			notify({
				title: '全部保存失败',
				message: cause instanceof Error ? cause.message : '无法连接运行时',
				color: 'red',
			})
		} finally {
			setSavingAll(false)
		}
	}, [
		canSaveAll,
		dirtyKeys,
		formStates,
		management,
		notify,
		owner,
		queryClient,
		savedConfig,
		savingAll,
		sectionItems,
	])

	useHotkeys(
		active
			? [
					[
						PLUGIN_DETAIL_HOTKEYS.saveCurrentConfig,
						(event: KeyboardEvent) => {
							event.preventDefault()
							submitCurrent()
						},
					],
					[
						PLUGIN_DETAIL_HOTKEYS.saveAllConfig,
						(event: KeyboardEvent) => {
							event.preventDefault()
							void saveAll()
						},
					],
				]
			: [],
		[],
		true,
	)

	if (!activeSection) return null

	return (
		<Box className="plx-pluginWorkbench__configForm">
			{active ? (
				<Box className="plx-pluginWorkbench__configToolbar">
					<ConfigActionDock
						activeKey={resolvedActiveKey}
						activeLabel={activeSection.label}
						activeState={activeState}
						dirtyLabels={dirtyLabels}
						hasMultipleSections={sectionItems.length > 1}
						savingAll={savingAll}
						canSaveAll={canSaveAll}
						sectionOptions={sectionItems.map((section) => ({
							value: section.key,
							label: `${section.label}${formStates[section.key]?.dirty ? ' •' : ''}`,
						}))}
						onActiveKeyChange={setActiveKey}
						onSubmitCurrent={submitCurrent}
						onSubmitAll={() => void saveAll()}
						onResetCurrent={resetCurrent}
						onResetDefaults={resetToDefaults}
					/>
				</Box>
			) : null}

			{sectionItems.map((section) => {
				const isActive = section.key === resolvedActiveKey
				return (
					<ConfigSectionPane
						key={section.key}
						active={active && isActive}
						displayName={displayName}
						isVisible={isActive}
						owner={owner}
						registerForm={registerForm}
						reportState={reportState}
						section={section}
					/>
				)
			})}
		</Box>
	)
}

function ConfigSectionPane({
	active,
	displayName,
	isVisible,
	owner,
	registerForm,
	reportState,
	section,
}: {
	active: boolean
	displayName: string
	isVisible: boolean
	owner: PluginNodeAddress
	registerForm: (key: string, bridge: ConfigFormBridge) => void | (() => void)
	reportState: (key: string, state: ConfigFormState) => void
	section: SectionItem
}) {
	const [scrollHost, setScrollHost] = useState<HTMLDivElement | null>(null)
	const setViewport = useCallback((node: HTMLDivElement | null) => {
		if (node) node.dataset.configScrollRoot = 'true'
		setScrollHost(node)
	}, [])

	return (
		<ScrollArea
			type="auto"
			scrollbarSize={10}
			offsetScrollbars
			className="plx-pluginWorkbench__configScrollArea"
			style={{ display: isVisible ? 'block' : 'none' }}
			viewportRef={setViewport}
		>
			<ConfigTabContent
				owner={owner}
				displayName={displayName}
				fields={section.fields}
				savedValue={section.savedValue}
				persistedValue={section.savedValue}
				defaultValue={section.defaultValue}
				path={section.path}
				showToc={active}
				scrollHost={scrollHost}
				registerForm={registerForm}
				reportState={reportState}
			/>
		</ScrollArea>
	)
}

function sectionKey(path: readonly string[]): string {
	return path.join('.') || 'config'
}

function sectionLabel(path: readonly string[]): string {
	return path.length === 0 ? '常规' : path.join(' / ')
}

function recordAtPath(record: Record<string, unknown>, path: readonly string[]) {
	let value: unknown = record
	for (const segment of path) {
		value = isRecord(value) ? value[segment] : undefined
	}
	return isRecord(value) ? value : {}
}

function sameFormState(left: ConfigFormState, right: ConfigFormState): boolean {
	return (
		left.dirty === right.dirty &&
		left.canSubmit === right.canSubmit &&
		left.submitting === right.submitting &&
		deepEqual(left.values, right.values)
	)
}

function deepEqual(left: unknown, right: unknown): boolean {
	if (Object.is(left, right)) return true
	if (Array.isArray(left) && Array.isArray(right)) {
		return (
			left.length === right.length && left.every((value, index) => deepEqual(value, right[index]))
		)
	}
	if (!isRecord(left) || !isRecord(right)) return false
	const leftKeys = Object.keys(left)
	const rightKeys = Object.keys(right)
	return (
		leftKeys.length === rightKeys.length &&
		leftKeys.every((key) => key in right && deepEqual(left[key], right[key]))
	)
}

function buildCombinedConfigPatch(
	savedConfig: Record<string, unknown>,
	sections: readonly SectionItem[],
	states: Readonly<Record<string, ConfigFormState>>,
	dirtyKeys: ReadonlySet<string>,
): Record<string, unknown> {
	const candidate = structuredClone(savedConfig)
	const changedRootKeys = new Set<string>()

	for (const section of sections) {
		if (!dirtyKeys.has(section.key)) continue
		const state = states[section.key]
		if (!state) continue
		const editablePatch = buildEditableConfigPatch(section.fields, state.values, section.savedValue)
		if (section.path.length === 0) {
			for (const [key, value] of Object.entries(editablePatch)) {
				candidate[key] = value
				changedRootKeys.add(key)
			}
			continue
		}

		const target = ensureRecordAtPath(candidate, section.path)
		Object.assign(target, editablePatch)
		changedRootKeys.add(section.path[0]!)
	}

	return Object.fromEntries([...changedRootKeys].map((key) => [key, candidate[key]]))
}

function ensureRecordAtPath(root: Record<string, unknown>, path: readonly string[]) {
	let current = root
	for (const segment of path) {
		const next = isRecord(current[segment]) ? current[segment] : {}
		current[segment] = next
		current = next
	}
	return current
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
