import { fileURLToPath } from 'node:url'
import type { ManagementUiSourceDeclaration } from './contracts'

function normalizeEntry(input: string): ManagementUiSourceDeclaration {
	const entryPath = String(input ?? '').trim()
	if (!entryPath) throw new Error('[management] managementUi(): entry path required')
	return Object.freeze({ entryPath })
}

export function managementUi(
	moduleUrl: string | URL,
	entryPath: string,
): ManagementUiSourceDeclaration {
	return normalizeEntry(fileURLToPath(new URL(entryPath, moduleUrl)))
}
