import { isWorkbenchEnabled, type WorkbenchConfig } from './workbench-config'

export type RuntimePlanePlan = Readonly<{
	management: boolean
	workbench: boolean
}>

/** @internal Resolve optional host planes once, before Context construction. */
export function resolveRuntimePlanePlan(
	workbenchConfig: WorkbenchConfig | undefined,
	management: true | undefined,
): RuntimePlanePlan {
	assertWorkbenchConfig(workbenchConfig)
	assertManagementFlag(management)
	const workbench = isWorkbenchEnabled(workbenchConfig)
	return Object.freeze({ management: workbench || management === true, workbench })
}

export function isRuntimeManagementEnabled(
	workbenchConfig: WorkbenchConfig | undefined,
	management: true | undefined,
): boolean {
	return resolveRuntimePlanePlan(workbenchConfig, management).management
}

function assertManagementFlag(value: true | undefined): void {
	if (value !== undefined && value !== true) {
		throw new TypeError('[pluxel/runtime] management must be true when provided')
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
