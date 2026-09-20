import { makePathArray } from '@tanstack/react-form'
import { Box, ScrollArea } from '@mantine/core'
import { useHotkeys } from '@mantine/hooks'
import type { PluginNodeAddress } from '@pluxel/core'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FieldNode } from 'valibot-form'

import { useRuntimeManagementClient } from '../../../runtime'
import { PLUGIN_DETAIL_HOTKEYS } from '../../workbench/shortcuts'
import { ConfigTabContent } from './ConfigTab'
import { useConfigForms, type ConfigSectionForm, type ConfigFormState } from './useConfigForms'
import { ConfigActionDock } from './components/ConfigActionDock'
import { buildEditableConfigPatch } from './presentationAdapter'
import { type PluginConfigSection } from './usePluginConfig'
import { useConfigSave } from './useConfigSave'
import { mapConfigValidationErrors, mountedFieldNames } from '../../forms/serverValidation'

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
	const { mutateAsync: saveConfig, isPending: saving, variables } = useConfigSave({ owner })
	const savingRef = useRef(false)
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
	const { formStates, forms, registerForm } = useConfigForms()

	useEffect(() => {
		if (sectionItems.some((section) => section.key === activeKey)) return
		setActiveKey(sectionItems[0]?.key ?? '')
	}, [activeKey, sectionItems])

	const dirtySections = sectionItems.filter((section) => formStates[section.key]?.dirty)
	const dirtyLabels = dirtySections.map((section) => section.label)
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
		if (!activeState.dirty || !activeState.canSubmit || activeState.submitting || saving) return
		void forms.get()[resolvedActiveKey]?.form.handleSubmit()
	}, [activeState, forms, resolvedActiveKey, saving])

	const resetCurrent = useCallback(() => {
		if (activeState.submitting || saving) return
		const bridge = forms.get()[resolvedActiveKey]
		if (!bridge || !activeSection) return
		bridge.reset(activeSection.initialValue)
	}, [activeSection, activeState.submitting, forms, resolvedActiveKey, saving])

	const resetToDefaults = useCallback(() => {
		if (activeState.submitting || saving) return
		const bridge = forms.get()[resolvedActiveKey]
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
	}, [activeSection, activeState.submitting, forms, resolvedActiveKey, saving])

	// Both native section submits and the save-all action enter the same transaction.
	const save = useCallback(
		async (key?: string) => {
			if (savingRef.current) return
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
			const patches = dirty.map(({ section, state }) => ({
				section,
				patch: buildEditableConfigPatch(section.fields, state.values, section.savedValue),
			}))
			const { section: currentSection, patch: sectionPatch } = patches[0]!
			const patch =
				key === undefined ? buildCombinedConfigPatch(savedConfig, patches) : sectionPatch
			if (Object.keys(patch).length === 0) return
			const unchanged = () =>
				targets.every(
					({ section, bridge, state }) =>
						forms.get()[section.key]?.form === bridge.form &&
						bridge.form.state.values === state.values,
				)
			const request =
				key !== undefined && currentSection.path.length > 0
					? () =>
							management.config.patchField(owner, {
								fieldPath: currentSection.path.join('.'),
								value: { ...currentSection.savedValue, ...sectionPatch },
							})
					: () => management.config.patch(owner, patch)
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
					onSaved: () => {
						for (const { section, bridge, state } of dirty) {
							if (forms.get()[section.key]?.form === bridge.form) bridge.acceptSaved(state.values)
						}
					},
				})
			} catch {
				// The mutation owns transport failure recovery and notification.
			} finally {
				savingRef.current = false
			}
		},
		[forms, management, owner, savedConfig, saveConfig, sectionItems],
	)
	const saveAll = useCallback(() => save(), [save])

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
				defaultValue={section.defaultValue}
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
	savedConfig: Record<string, unknown>,
	submissions: readonly { section: SectionItem; patch: Record<string, unknown> }[],
): Record<string, unknown> {
	const candidate = structuredClone(savedConfig)
	const changedRootKeys = new Set<string>()

	for (const { section, patch: editablePatch } of submissions) {
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
