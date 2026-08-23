import type { PluginDefinitionAddress } from '@pluxel/core'
import { resolveAdminAccessConfig } from './services/admin-access/model'
import type { AdminAccessConfig, ResolvedAdminAccessConfig } from './services/admin-access/types'
import { isWorkbenchEnabled, type WorkbenchConfig } from './workbench-config'

export type {
	AdminAccessClaimRequirement,
	AdminAccessConfig,
	AdminAccessExposure,
	AdminAccessOidcConfig,
} from './services/admin-access/types'

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
	/**
	 * Management access policy. Omitted access is private.
	 * Public exposure requires an OIDC policy.
	 */
	access?: AdminAccessConfig
	/** Closed set of host-owned Plugin catalog classifications. */
	pluginGroups?: readonly PluginGroupConfig[]
}>

export type RuntimePlanePlan = Readonly<{
	management: boolean
	workbench: boolean
	access?: ResolvedAdminAccessConfig
}>

/** @internal Resolve the two optional host planes once, before Context construction. */
export function resolveRuntimePlanePlan(
	workbenchConfig: WorkbenchConfig | undefined,
	managementConfig: ManagementConfig | undefined,
): RuntimePlanePlan {
	assertWorkbenchConfig(workbenchConfig)
	const workbench = isWorkbenchEnabled(workbenchConfig)
	assertManagementConfig(managementConfig)
	const management = workbench || managementConfig !== undefined
	if (!management) return Object.freeze({ management: false, workbench: false })

	const access = freezeAdminAccess(resolveAdminAccessConfig(managementConfig?.access))
	if (access.exposure === 'public' && !access.oidc) {
		throw new Error('[pluxel/runtime] Public management access requires management.access.oidc.')
	}
	return Object.freeze({ management: true, workbench, access })
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
	const unknown = Object.keys(value).filter((key) => key !== 'access' && key !== 'pluginGroups')
	if (unknown.length > 0) {
		throw new TypeError(
			`[pluxel/runtime] management includes unsupported ${unknown.map((key) => `"${key}"`).join(', ')}`,
		)
	}
	if (value.pluginGroups !== undefined && !Array.isArray(value.pluginGroups)) {
		throw new TypeError('[pluxel/runtime] management.pluginGroups must be an array')
	}
	assertAdminAccessConfig(value.access)
}

function assertAdminAccessConfig(value: AdminAccessConfig | undefined): void {
	if (value === undefined) return
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new TypeError('[pluxel/runtime] management.access must be a configuration object')
	}
	const unknown = Object.keys(value).filter((key) => key !== 'exposure' && key !== 'oidc')
	if (unknown.length > 0) {
		throw new TypeError(
			`[pluxel/runtime] management.access includes unsupported ${unknown.map((key) => `"${key}"`).join(', ')}`,
		)
	}
	if (value.exposure !== undefined && value.exposure !== 'private' && value.exposure !== 'public') {
		throw new TypeError('[pluxel/runtime] management.access.exposure must be private or public')
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

function freezeAdminAccess(config: ResolvedAdminAccessConfig): ResolvedAdminAccessConfig {
	const oidc = config.oidc
		? Object.freeze({
				...config.oidc,
				...(Array.isArray(config.oidc.audience)
					? { audience: Object.freeze([...config.oidc.audience]) }
					: {}),
				...(config.oidc.requiredClaims
					? {
							requiredClaims: Object.freeze(
								Object.fromEntries(
									Object.entries(config.oidc.requiredClaims).map(([name, requirement]) => [
										name,
										Array.isArray(requirement) ? Object.freeze([...requirement]) : requirement,
									]),
								),
							),
						}
					: {}),
			})
		: undefined
	return Object.freeze({
		...config,
		...(oidc ? { oidc } : {}),
	}) as ResolvedAdminAccessConfig
}
