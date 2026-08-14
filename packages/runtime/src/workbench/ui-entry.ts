const WORKBENCH_UI_ENTRY = Symbol.for('pluxel:workbench-ui-entry')
declare const workbenchUiEntryBrand: unique symbol

export type WorkbenchUiEntry = Readonly<{ [workbenchUiEntryBrand]: true }>

export type WorkbenchUiEntryDescriptor = Readonly<{
	moduleUrl: string
	entryPath: string
	artifactKey?: string
}>

export function createWorkbenchUiEntry(
	moduleUrl: string | URL,
	entryPath: string,
	loweredKey?: unknown,
): WorkbenchUiEntry {
	const normalized = String(entryPath ?? '').trim()
	if (!normalized) throw new Error('[workbench] workbench.entry(): entry path required')
	const declarationUrl = new URL(String(moduleUrl))
	if (declarationUrl.protocol !== 'file:') {
		throw new Error('[workbench] workbench.entry(): module URL must use the file protocol')
	}
	const artifactKey = typeof loweredKey === 'string' ? loweredKey.trim() : ''
	return Object.freeze({
		[WORKBENCH_UI_ENTRY]: Object.freeze({
			moduleUrl: declarationUrl.href,
			entryPath: normalized,
			...(artifactKey ? { artifactKey } : {}),
		} satisfies WorkbenchUiEntryDescriptor),
	}) as unknown as WorkbenchUiEntry
}

export function readWorkbenchUiEntry(entry: WorkbenchUiEntry): WorkbenchUiEntryDescriptor {
	const value = (entry as unknown as Record<PropertyKey, unknown>)[WORKBENCH_UI_ENTRY]
	if (!value || typeof value !== 'object') {
		throw new TypeError('[workbench] invalid UI entry declaration')
	}
	return value as WorkbenchUiEntryDescriptor
}
