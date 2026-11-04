import { Box, ScrollArea, Text } from '@mantine/core'
import { useHotkeys } from '@mantine/hooks'
import { type PluginNodeAddress } from '@pluxel/core'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { type FieldNode } from 'valibot-form'
import type { ConfigPatch } from '@pluxel/services/management/client'

import { useRuntimeManagementClient } from '../../../runtime'
import { PLUGIN_DETAIL_HOTKEYS } from '../../workbench/shortcuts'
import { ConfigTabContent } from './ConfigTab'
import { useConfigForms, type ConfigSectionForm, type ConfigFormState } from './useConfigForms'
import { ConfigActionDock } from './components/ConfigActionDock'
import { buildEditableConfigPatch, editableConfigPaths } from './presentationAdapter'
import { type PluginConfigSection, type PluginConfigSnapshot } from './usePluginConfig'
import { useConfigSave } from './useConfigSave'
import { mapConfigValidationErrors, mountedFieldNames } from '../../forms/serverValidation'
import { useOptionalWorkbenchDocument } from '../../workbench/document'
import { useOptionalWorkspaceSession } from '../../workbench/workspaceContext'

const EMPTY_CONFIG_SECTIONS: readonly PluginConfigSection[] = []
const EMPTY_FORM_STATE: ConfigFormState = {
	dirty: false,
	canSubmit: false,
	submitting: false,
}

type ConfigFormProps = {
	owner: PluginNodeAddress
	displayName: string
	fields: readonly FieldNode[]
	snapshot: PluginConfigSnapshot
	active?: boolean
	onDirtyChange?: (dirty: boolean) => void
	sections?: readonly PluginConfigSection[]
}

type SectionItem = {
	key: string
	label: string
	path: readonly string[]
	fields: readonly FieldNode[]
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
	snapshot,
	active = true,
	onDirtyChange,
	sections,
}: ConfigFormProps & { sections: readonly PluginConfigSection[] }) {
	const management = useRuntimeManagementClient()
	const readOnly = snapshot.readonly
	const [editingRevision, setEditingRevision] = useState(snapshot.managedRevision)
	const document = useOptionalWorkbenchDocument()
	const workspace = useOptionalWorkspaceSession()
	const { mutateAsync: saveConfig, isPending: saving, variables } = useConfigSave({ owner })
	const savingRef = useRef(false)
	const visibleSections = useMemo<readonly PluginConfigSection[]>(
		() => (sections.length > 0 ? sections : [{ path: [], fields, fieldName: '' }]),
		[fields, sections],
	)
	const sectionItems = useMemo<SectionItem[]>(
		() =>
			visibleSections.map((section) => {
				const savedValue = recordAtPath(snapshot.managedInput ?? {}, section.path)
				return {
					key: sectionKey(section.path),
					label: sectionLabel(section.path),
					path: section.path,
					fields: section.fields,
					savedValue,
					initialValue: savedValue,
				}
			}),
		[snapshot.managedInput, visibleSections],
	)
	const [activeKey, setActiveKey] = useState(sectionItems[0]?.key ?? '')
	const { formStates, forms, registerForm } = useConfigForms()

	useEffect(() => {
		if (sectionItems.some((section) => section.key === activeKey)) return
		setActiveKey(sectionItems[0]?.key ?? '')
	}, [activeKey, sectionItems])

	const dirtySections = sectionItems.filter((section) => formStates[section.key]?.dirty)
	const dirtyLabels = dirtySections.map((section) => section.label)
	useEffect(() => {
		if (dirtySections.length === 0) setEditingRevision(snapshot.managedRevision)
	}, [dirtySections.length, snapshot.managedRevision])
	const activeSection = sectionItems.find((section) => section.key === activeKey) ?? sectionItems[0]
	const resolvedActiveKey = activeSection?.key ?? ''
	const activeState = formStates[resolvedActiveKey] ?? EMPTY_FORM_STATE
	const canSaveAll = dirtySections.every((section) => {
		const state = formStates[section.key]
		return Boolean(state?.canSubmit && !state.submitting)
	})

	useEffect(() => {
		onDirtyChange?.(dirtySections.length > 0)
	}, [dirtySections.length, onDirtyChange])

	const submitCurrent = useCallback(() => {
		if (
			readOnly ||
			!activeState.dirty ||
			!activeState.canSubmit ||
			activeState.submitting ||
			saving
		)
			return
		void forms.get()[resolvedActiveKey]?.form.handleSubmit()
	}, [activeState, forms, readOnly, resolvedActiveKey, saving])

	const resetCurrent = useCallback(() => {
		if (activeState.submitting || saving) return
		const bridge = forms.get()[resolvedActiveKey]
		if (!bridge || !activeSection) return
		bridge.reset(activeSection.initialValue)
	}, [activeSection, activeState.submitting, forms, resolvedActiveKey, saving])

	const restoreInheritance = useCallback(async () => {
		if (readOnly || savingRef.current || activeState.submitting || !activeSection) return
		const bridge = forms.get()[resolvedActiveKey]
		if (!bridge) return
		const submitted = bridge.form.state.values
		const paths = editableConfigPaths(activeSection.fields, activeSection.path)
		if (paths.length === 0) return
		savingRef.current = true
		try {
			await saveConfig({
				request: () =>
					management.config.reset(owner, paths, { expectedManagedRevision: editingRevision }),
				all: false,
				sectionCount: 1,
				onValidation: (errors) => {
					if (bridge.form.state.values === submitted)
						bridge.form.setErrorMap({
							onServer: mapConfigValidationErrors(
								errors,
								mountedFieldNames(bridge.form),
								activeSection.path,
							),
						} as never)
				},
				onSaved: (result) => {
					setEditingRevision(result.managedRevision)
					if (forms.get()[resolvedActiveKey]?.form === bridge.form)
						bridge.acceptSaved(
							recordAtPath(result.managedInput ?? {}, activeSection.path),
							submitted,
						)
				},
			})
		} catch {
			// The mutation owns failure feedback; keep the draft until confirmed.
		} finally {
			savingRef.current = false
		}
	}, [
		activeSection,
		activeState.submitting,
		editingRevision,
		forms,
		management.config,
		owner,
		readOnly,
		resolvedActiveKey,
		saveConfig,
	])

	// Both native section submits and the save-all action enter the same transaction.
	const save = useCallback(
		async (key?: string) => {
			if (readOnly || savingRef.current) return
			const submitted = sectionItems.flatMap((section) => {
				const bridge = forms.get()[section.key]
				return bridge ? [{ section, bridge, state: bridge.form.state }] : []
			})
			const targets =
				key === undefined ? submitted : submitted.filter(({ section }) => section.key === key)
			const dirty = targets.filter(({ state }) => state.isDirty)
			if (dirty.length === 0 || dirty.some(({ state }) => !state.canSubmit && !state.isSubmitting))
				return
			// Native submits compete for the synchronous guard; save-all waits for their validation.
			if (key === undefined && submitted.some(({ state }) => state.isSubmitting)) return
			const patches = dirty.map(({ section, bridge, state }) => ({
				section,
				patch: buildEditableConfigPatch(section.fields, state.values, bridge.baseline),
			}))
			const patch = buildCombinedConfigPatch(patches)
			if (!patch.set && !patch.remove?.length) return
			const unchanged = () =>
				targets.every(
					({ section, bridge, state }) =>
						forms.get()[section.key]?.form === bridge.form &&
						bridge.form.state.values === state.values,
				)
			const request = () =>
				management.config.patch(owner, patch, { expectedManagedRevision: editingRevision })
			savingRef.current = true
			for (const { bridge } of targets)
				bridge.form.setErrorMap({ onServer: { fields: {} } } as never)
			try {
				await saveConfig({
					request,
					all: key === undefined,
					sectionCount: dirty.length,
					onValidation: (errors) => {
						if (!unchanged()) return
						for (const { section, bridge } of targets)
							bridge.form.setErrorMap({
								onServer: mapConfigValidationErrors(
									errors,
									mountedFieldNames(bridge.form),
									section.path,
								),
							} as never)
					},
					onSaved: (result) => {
						setEditingRevision(result.managedRevision)
						for (const { section, bridge, state } of dirty) {
							if (forms.get()[section.key]?.form === bridge.form)
								bridge.acceptSaved(
									recordAtPath(result.managedInput ?? {}, section.path),
									state.values,
								)
						}
					},
				})
			} catch {
				// The mutation owns transport failure recovery and notification.
			} finally {
				savingRef.current = false
			}
		},
		[editingRevision, forms, management, owner, readOnly, saveConfig, sectionItems],
	)
	const saveAll = useCallback(() => save(), [save])
	const saveRef = useRef(saveAll)
	saveRef.current = saveAll
	const lifecycle = useMemo(() => {
		let facts: readonly unknown[] = []
		let revision = 0
		return {
			isDirty: () => Object.values(forms.get()).some(({ form }) => form.state.isDirty),
			getCloseRevision: () => {
				// Immutable form values and registered form identities are the editing
				// facts; keep a stable aggregate only while every actual fact is equal.
				const current = Object.entries(forms.get()).flatMap(([key, { form }]) => [
					key,
					form,
					form.state.values,
				])
				if (
					current.length !== facts.length ||
					current.some((value, index) => value !== facts[index])
				) {
					facts = current
					revision++
				}
				return revision
			},
			save: () => saveRef.current(),
		}
	}, [forms])
	useEffect(() => {
		if (!document) return
		document.state.editor = lifecycle
		workspace?.notifyContentState()
		return () => {
			if (document.state.editor === lifecycle) document.state.editor = undefined
			workspace?.notifyContentState()
		}
	}, [document, lifecycle, workspace])
	useEffect(() => {
		workspace?.notifyContentState()
	}, [dirtySections.length, workspace])

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
		<Box
			component="fieldset"
			disabled={readOnly}
			className="plx-pluginWorkbench__configForm"
			style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}
		>
			{readOnly ? (
				<Text size="sm" c="dimmed">
					当前宿主的配置只读。
				</Text>
			) : null}
			{!snapshot.ok ? (
				<Text size="sm" c="red">
					当前有效配置未通过校验：{snapshot.message}。请修改保存输入后重新提交。
				</Text>
			) : null}
			{snapshot.shadowedPaths.length > 0 ? (
				<Text size="sm" c="dimmed">
					部分保存值被应用声明覆盖；修改这些值不会立即改变当前生效配置。
				</Text>
			) : null}
			<Text size="xs" c="dimmed">
				表单编辑保存输入。未设置的字段继续继承声明或插件默认值。
			</Text>
			{active ? (
				<Box className="plx-pluginWorkbench__configToolbar">
					<ConfigActionDock
						activeKey={resolvedActiveKey}
						activeLabel={activeSection.label}
						activeState={activeState}
						dirtyLabels={dirtyLabels}
						hasMultipleSections={sectionItems.length > 1}
						savingScope={saving ? (variables?.all ? 'all' : 'current') : undefined}
						canSaveAll={canSaveAll}
						sectionOptions={sectionItems.map((section) => ({
							value: section.key,
							label: `${section.label}${formStates[section.key]?.dirty ? ' •' : ''}`,
						}))}
						onActiveKeyChange={setActiveKey}
						onSubmitCurrent={submitCurrent}
						onSubmitAll={() => void saveAll()}
						onResetCurrent={resetCurrent}
						onRestoreInheritance={() => void restoreInheritance()}
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
						onSubmit={save}
						registerForm={registerForm}
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
	onSubmit,
	registerForm,
	section,
}: {
	active: boolean
	displayName: string
	isVisible: boolean
	onSubmit: (key: string) => Promise<void>
	registerForm: (key: string, form: ConfigSectionForm) => () => void
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
				onSubmit={onSubmit}
				displayName={displayName}
				fields={section.fields}
				savedValue={section.savedValue}
				path={section.path}
				showToc={active}
				scrollHost={scrollHost}
				registerForm={registerForm}
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

function buildCombinedConfigPatch(
	submissions: readonly { section: SectionItem; patch: ConfigPatch }[],
): ConfigPatch {
	const set: Record<string, unknown> = {}
	const remove: (readonly string[])[] = []
	for (const { section, patch } of submissions) {
		if (patch.set) Object.assign(ensureRecordAtPath(set, section.path), patch.set)
		for (const path of patch.remove ?? []) remove.push([...section.path, ...path])
	}
	return {
		...(Object.keys(set).length > 0 ? { set } : {}),
		...(remove.length > 0 ? { remove } : {}),
	}
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
