import { Group, Loader, Stack, Text } from '@mantine/core'
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
	getRuntimeSecurityClient,
	type SecurityAuditEvent,
	type SecurityOverview,
	type VaultKeyPair,
	rpcErrorMessage,
} from '../../runtime'
import { ErrorState } from '../../components'
import { useNotify } from '../hooks/useNotify'
import { useStoredSplitLayout, WorkbenchSplitView } from '../workbench/split'
import {
	DEFAULT_SECURITY_SPLIT_LAYOUT,
	formatRecipientsDraft,
	parseRecipientsDraft,
	type RefreshOptions,
	SECURITY_CONTROLS_PANEL_ID,
	SECURITY_NAMESPACE_PANEL_ID,
	SECURITY_SPLIT_LAYOUT_STORAGE_KEY,
	sanitizeSecuritySplitLayout,
	type SecurityBusyKey,
	summarizeInventory,
} from './securityModel'
import { NamespaceInventoryPanel, SecurityControlsPane, SecurityToolbar } from './SecurityPanels'

export function SecurityScreen() {
	const notify = useNotify()
	const security = getRuntimeSecurityClient()
	const vaultApi = security.vault
	const [overview, setOverview] = useState<SecurityOverview | null>(null)
	const [events, setEvents] = useState<SecurityAuditEvent[]>([])
	const [loading, setLoading] = useState(true)
	const [refreshing, setRefreshing] = useState(false)
	const [busy, setBusy] = useState<SecurityBusyKey | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [deployRecipientsDraft, setDeployRecipientsDraft] = useState('')
	const [namespaceSearch, setNamespaceSearch] = useState('')
	const [generatedKeyPair, setGeneratedKeyPair] = useState<VaultKeyPair | null>(null)
	const adminAccess = overview?.adminAccess ?? null
	const vault = overview?.vault ?? null
	const deployRecipients = useMemo(
		() => parseRecipientsDraft(deployRecipientsDraft),
		[deployRecipientsDraft],
	)
	const namespaceSearchTerm = namespaceSearch.trim().toLowerCase()
	const filteredNamespaces = useMemo(
		() =>
			(vault?.namespaces ?? []).filter((row) =>
				row.namespace.toLowerCase().includes(namespaceSearchTerm),
			),
		[vault?.namespaces, namespaceSearchTerm],
	)
	const [securitySplitLayout, handleSecuritySplitLayoutChanged] = useStoredSplitLayout(
		SECURITY_SPLIT_LAYOUT_STORAGE_KEY,
		DEFAULT_SECURITY_SPLIT_LAYOUT,
		sanitizeSecuritySplitLayout,
	)

	const applyOverview = useCallback(
		(nextOverview: SecurityOverview, options: RefreshOptions = {}) => {
			setOverview(nextOverview)
			if (options.syncDeployRecipientsDraft) {
				setDeployRecipientsDraft(formatRecipientsDraft(nextOverview.vault.deploy.recipients))
			}
		},
		[],
	)

	const refresh = useCallback(
		async (options: RefreshOptions = {}) => {
			setRefreshing(true)
			setError(null)
			try {
				const [nextOverview, nextEvents] = await Promise.all([
					security.readOverview(),
					security.listEvents(),
				])
				applyOverview(nextOverview, options)
				setEvents(nextEvents)
			} catch (cause) {
				setError(rpcErrorMessage(cause, 'Failed to load security state'))
			} finally {
				setLoading(false)
				setRefreshing(false)
			}
		},
		[applyOverview, security],
	)

	useEffect(() => {
		void refresh({ syncDeployRecipientsDraft: true })
	}, [refresh])

	async function generateDeployKey() {
		setBusy('vault-deploy-generate')
		try {
			const result = await vaultApi.generateDeployKey()
			setGeneratedKeyPair(result)
			await refresh()
			notify({ color: 'green', message: 'Deploy key generated' })
		} catch (cause) {
			notify({ color: 'red', message: rpcErrorMessage(cause, 'Failed to generate deploy key') })
		} finally {
			setBusy(null)
		}
	}

	async function saveDeployRecipients() {
		setBusy('vault-deploy-save')
		try {
			const recipients = parseRecipientsDraft(deployRecipientsDraft)
			await vaultApi.setDeployRecipients(recipients)
			await refresh({ syncDeployRecipientsDraft: true })
			notify({ color: 'green', message: 'Deploy recipients saved' })
		} catch (cause) {
			notify({ color: 'red', message: rpcErrorMessage(cause, 'Failed to save deploy recipients') })
		} finally {
			setBusy(null)
		}
	}

	if (loading) {
		return (
			<Group justify="center" p="xl">
				<Loader size="sm" />
				<Text c="dimmed">Loading security state</Text>
			</Group>
		)
	}

	if (error || !overview || !adminAccess || !vault) {
		return (
			<ErrorState
				title="Security state unavailable"
				message={error ?? 'The runtime did not return security state.'}
				onRetry={() => void refresh({ syncDeployRecipientsDraft: true })}
			/>
		)
	}

	const inventory = summarizeInventory(vault)
	const deployRecipientsSaved = formatRecipientsDraft(vault.deploy.recipients)
	const deployRecipientsDirty = deployRecipientsDraft !== deployRecipientsSaved
	const failedEvents = events.filter((event) => event.status === 'failure').length
	const totalNamespaces = vault.namespaces?.length ?? 0
	return (
		<Stack gap="sm" style={{ flex: 1, minHeight: 0 }}>
			<SecurityToolbar
				adminAccess={adminAccess}
				failedEvents={failedEvents}
				namespaceCount={filteredNamespaces.length}
				onRefresh={() => void refresh({ syncDeployRecipientsDraft: !deployRecipientsDirty })}
				refreshing={refreshing}
				totalNamespaces={totalNamespaces}
				vault={vault}
			/>
			<WorkbenchSplitView
				className="plx-workbench__panelGroup"
				layout={securitySplitLayout}
				id="pluxel-security-split"
				onLayoutCommit={handleSecuritySplitLayoutChanged}
				orientation="horizontal"
				primary={{
					id: SECURITY_CONTROLS_PANEL_ID,
					defaultSize: securitySplitLayout[SECURITY_CONTROLS_PANEL_ID],
					minSize: 20,
					children: (
						<SecurityControlsPane
							adminAccess={adminAccess}
							busy={busy}
							deployRecipients={deployRecipients}
							deployRecipientsDirty={deployRecipientsDirty}
							deployRecipientsDraft={deployRecipientsDraft}
							generatedKeyPair={generatedKeyPair}
							onDeployRecipientsDraftChange={setDeployRecipientsDraft}
							onGenerateDeployKey={() => void generateDeployKey()}
							onSaveDeployRecipients={() => void saveDeployRecipients()}
							vault={vault}
						/>
					),
				}}
				secondary={{
					id: SECURITY_NAMESPACE_PANEL_ID,
					defaultSize: securitySplitLayout[SECURITY_NAMESPACE_PANEL_ID],
					minSize: 52,
					children: (
						<NamespaceInventoryPanel
							filteredNamespaces={filteredNamespaces}
							inventory={inventory}
							namespaceSearch={namespaceSearch}
							onNamespaceSearchChange={setNamespaceSearch}
							totalNamespaces={totalNamespaces}
						/>
					),
				}}
			/>
		</Stack>
	)
}
