import type { SecurityOverview, VaultAdminState } from '../../runtime'
import { sanitizeTwoPanelLayout } from '../workbench/split'

export type RefreshOptions = {
	syncDeployRecipientsDraft?: boolean
}

export type SecurityBusyKey = 'vault-deploy-generate' | 'vault-deploy-save'

export const SECURITY_CONTROLS_PANEL_ID = 'pluxel-security-controls'
export const SECURITY_NAMESPACE_PANEL_ID = 'pluxel-security-namespaces'
export const SECURITY_SPLIT_LAYOUT_STORAGE_KEY = 'pluxel:security:split'

export const DEFAULT_SECURITY_SPLIT_LAYOUT = {
	[SECURITY_CONTROLS_PANEL_ID]: 28,
	[SECURITY_NAMESPACE_PANEL_ID]: 72,
}

export function sanitizeSecuritySplitLayout(layout: Record<string, number>) {
	return sanitizeTwoPanelLayout(
		layout,
		DEFAULT_SECURITY_SPLIT_LAYOUT,
		SECURITY_CONTROLS_PANEL_ID,
		20,
		52,
	)
}

export function toneForReason(reason?: string): string {
	switch (reason) {
		case 'private':
			return 'gray'
		case 'missing_oidc':
		case 'invalid_token':
		case 'forbidden':
			return 'red'
		case 'unauthenticated':
			return 'orange'
		case 'unlock_required':
			return 'blue'
		default:
			return 'gray'
	}
}

export function labelForAccessState(adminAccess: SecurityOverview['adminAccess']): string {
	if (adminAccess.allow && adminAccess.exposure === 'private') return 'private'
	if (adminAccess.allow) return 'admin allowed'
	switch (adminAccess.reason) {
		case 'missing_oidc':
			return 'missing oidc'
		case 'unauthenticated':
			return 'unauthenticated'
		case 'invalid_token':
			return 'invalid token'
		case 'forbidden':
			return 'forbidden'
		default:
			return 'blocked'
	}
}

export function labelForVaultState(vault: VaultAdminState): string {
	if (vault.lastError) return 'error'
	if (vault.unlocked) return 'unlocked'
	if (!vault.present) return 'empty'
	return 'sealed'
}

export function labelForUnlockSource(source: VaultAdminState['unlockedBy']): string {
	if (source === 'host') return 'host'
	if (source === 'deploy') return 'deploy'
	return '-'
}

export function summarizeInventory(vault: VaultAdminState) {
	const namespaces = vault.namespaces ?? []
	return namespaces.reduce(
		(acc, row) => {
			acc.namespaces += 1
			acc.kv += row.kvKeys
			acc.docs += row.docDocuments
			acc.blobs += row.blobs
			return acc
		},
		{ namespaces: 0, kv: 0, docs: 0, blobs: 0 },
	)
}

export function parseRecipientsDraft(input: string): string[] {
	const seen = new Set<string>()
	const recipients: string[] = []
	for (const line of input.split('\n')) {
		const recipient = line.trim()
		if (!recipient || seen.has(recipient)) continue
		seen.add(recipient)
		recipients.push(recipient)
	}
	return recipients
}

export function formatRecipientsDraft(input: string[]): string {
	return input.join('\n')
}
