import type { overviewQuery } from './scope.ts'
export type VaultSnapshot = NonNullable<
	Extract<
		NonNullable<ReturnType<typeof overviewQuery.useQuery>['data']>,
		{ enabled: true }
	>['state']
>
export type SecurityBusyKey = 'vault-deploy-generate' | 'vault-deploy-save'

export function labelForVaultState(vault: VaultSnapshot): string {
	if (vault.lastError) return 'error'
	if (vault.unlocked) return 'unlocked'
	if (!vault.present) return 'empty'
	return 'sealed'
}

export function labelForUnlockSource(source: VaultSnapshot['unlockedBy']): string {
	if (source === 'host') return 'host'
	if (source === 'deploy') return 'deploy'
	return '-'
}

export function summarizeInventory(vault: VaultSnapshot) {
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

export function formatRecipientsDraft(input: readonly string[]): string {
	return input.join('\n')
}
