import {
	Alert,
	Badge,
	Button,
	Group,
	Loader,
	MantineProvider,
	SimpleGrid,
	Stack,
	Text,
} from '@mantine/core'
import { useEffect, useRef, useState } from 'react'
import type { VaultKeyPair } from '@pluxel/services/vault'
import { overviewQuery, securityOf, vaultScope } from './scope.ts'
import { DeployKeyPanel, NamespaceInventoryPanel } from './panels.tsx'
import {
	formatRecipientsDraft,
	labelForUnlockSource,
	labelForVaultState,
	parseRecipientsDraft,
	summarizeInventory,
	type SecurityBusyKey,
} from './model.ts'

function VaultPage() {
	const { host } = vaultScope.useWorkbench()
	const query = overviewQuery.useQuery()
	const [draft, setDraft] = useState('')
	const initialized = useRef(false)
	const [search, setSearch] = useState('')
	const [busy, setBusy] = useState<SecurityBusyKey | null>(null)
	const [keyPair, setKeyPair] = useState<VaultKeyPair | null>(null)
	const vault = query.data?.enabled ? query.data.state : null
	useEffect(() => {
		if (!vault || initialized.current) return
		initialized.current = true
		setDraft(formatRecipientsDraft(vault.deploy.recipients))
	}, [vault])
	async function perform(operation: SecurityBusyKey) {
		setBusy(operation)
		try {
			const api = securityOf(host).vault
			if (operation === 'vault-deploy-generate') setKeyPair(await api.generateDeployKey())
			else {
				const state = await api.setDeployRecipients(parseRecipientsDraft(draft))
				setDraft(formatRecipientsDraft(state.deploy.recipients))
			}
			await query.refetch()
			host.notify({
				tone: 'success',
				message:
					operation === 'vault-deploy-generate'
						? 'Deploy key generated'
						: 'Deploy recipients saved',
			})
		} catch (cause) {
			host.notify({
				tone: 'error',
				message: cause instanceof Error ? cause.message : String(cause),
			})
		} finally {
			setBusy(null)
		}
	}
	if (query.isPending) return <Loader size="sm" />
	if (query.error)
		return (
			<Alert color="red">
				{String(query.error)}
				<Button onClick={() => void query.refetch()}>Retry</Button>
			</Alert>
		)
	if (!vault) return <Text>Vault is unavailable.</Text>
	const filtered = (vault.namespaces ?? []).filter((row) =>
		row.namespace.toLowerCase().includes(search.trim().toLowerCase()),
	)
	return (
		<Stack p="sm">
			<Group justify="space-between">
				<Group>
					<Badge color={vault.unlocked ? 'green' : 'orange'}>
						Vault {labelForVaultState(vault)}
					</Badge>
					<Text size="sm">
						Unlock source: {labelForUnlockSource(vault.unlockedBy)} · Host identity:{' '}
						{vault.hostIdentityPresent ? 'ready' : 'missing'}
					</Text>
				</Group>
				<Button variant="light" loading={query.isFetching} onClick={() => void query.refetch()}>
					Refresh
				</Button>
			</Group>
			{vault.lastError ? <Alert color="red">{vault.lastError.message}</Alert> : null}
			<SimpleGrid cols={{ base: 1, lg: 2 }}>
				<DeployKeyPanel
					busy={busy}
					deployRecipients={parseRecipientsDraft(draft)}
					deployRecipientsDirty={draft !== formatRecipientsDraft(vault.deploy.recipients)}
					deployRecipientsDraft={draft}
					generatedKeyPair={keyPair}
					onDeployRecipientsDraftChange={setDraft}
					onGenerateDeployKey={() => void perform('vault-deploy-generate')}
					onSaveDeployRecipients={() => void perform('vault-deploy-save')}
					vault={vault}
				/>
				<NamespaceInventoryPanel
					filteredNamespaces={filtered}
					inventory={summarizeInventory(vault)}
					namespaceSearch={search}
					onNamespaceSearchChange={setSearch}
					totalNamespaces={(vault.namespaces ?? []).length}
				/>
			</SimpleGrid>
		</Stack>
	)
}
function Page() {
	const { host } = vaultScope.useWorkbench()
	return (
		<MantineProvider forceColorScheme={host.colorScheme}>
			<VaultPage />
		</MantineProvider>
	)
}
export default vaultScope.render(Page)
