import type { PluginDefinitionAddress } from '@pluxel/core'
import { isWorkbenchEnabled, type WorkbenchConfig } from './workbench-config'

export type PluginGroupConfig = Readonly<{
	/** Stable host-owned group identity. The `package:` prefix is reserved. */
	id: string
	/** Canonical display name. Management clients cannot rename registered groups. */
	name: string
	/** Exact Plugin definitions; all default/fork nodes inherit the classification. */
	definitions?: readonly PluginDefinitionAddress[]
	/** Exact package names or a package-name prefix with one trailing `*`. */
	packages?: readonly string[]
}>

export type ManagementConfig = Readonly<{
	/** Closed set of host-owned Plugin catalog classifications. */
	pluginGroups?: readonly PluginGroupConfig[]
}>

export type RuntimePlanePlan = Readonly<{
	management: boolean
	workbench: boolean
}>

/** @internal Resolve the two optional host planes once, before Context construction. */
export function resolveRuntimePlanePlan(
	workbenchConfig: WorkbenchConfig | undefined,
	managementConfig: ManagementConfig | undefined,
): RuntimePlanePlan {
	assertWorkbenchConfig(workbenchConfig)
	const workbench = isWorkbenchEnabled(workbenchConfig)
	assertManagementConfig(managementConfig)
	return Object.freeze({ management: workbench || managementConfig !== undefined, workbench })
}

export function isRuntimeManagementEnabled(
	workbenchConfig: WorkbenchConfig | undefined,
	managementConfig: ManagementConfig | undefined,
): boolean {
	return resolveRuntimePlanePlan(workbenchConfig, managementConfig).management
}

function assertManagementConfig(value: ManagementConfig | undefined): void {
	if (value === undefined) return
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new TypeError('[pluxel/runtime] management must be a configuration object')
	}
	const unknown = Object.keys(value).filter((key) => key !== 'pluginGroups')
	if (unknown.length > 0) {
		throw new TypeError(
			`[pluxel/runtime] management includes unsupported ${unknown.map((key) => `"${key}"`).join(', ')}`,
		)
	}
	if (value.pluginGroups !== undefined && !Array.isArray(value.pluginGroups)) {
		throw new TypeError('[pluxel/runtime] management.pluginGroups must be an array')
	}
}

function assertWorkbenchConfig(value: WorkbenchConfig | undefined): void {
	if (value === undefined || value === false) return
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new TypeError('[pluxel/runtime] workbench must be false or a configuration object')
	}
	const unknown = Object.keys(value).filter((key) => key !== 'enabled' && key !== 'uiBasePath')
	if (unknown.length > 0) {
		throw new TypeError(
			`[pluxel/runtime] workbench includes unsupported ${unknown.map((key) => `"${key}"`).join(', ')}`,
		)
	}
	if (value.enabled !== true) {
		throw new TypeError('[pluxel/runtime] workbench.enabled must be true')
	}
}
