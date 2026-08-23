import { Group, Loader, Stack, Text } from '@mantine/core'
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
	type SecurityAuditEvent,
	type SecurityOverview,
	type VaultKeyPair,
	runtimeErrorMessage,
	useRuntimeManagementClient,
} from '../../runtime'
import { EmptyState, ErrorState } from '../../components'
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
	const security = useRuntimeManagementClient().security
	const vaultApi = security.vault
	const [overview, setOverview] = useState<SecurityOverview | null>(null)
	const [events, setEvents] = useState<readonly SecurityAuditEvent[]>([])
	const [loading, setLoading] = useState(true)
	const [refreshing, setRefreshing] = useState(false)
	const [busy, setBusy] = useState<SecurityBusyKey | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [deployRecipientsDraft, setDeployRecipientsDraft] = useState('')
	const [namespaceSearch, setNamespaceSearch] = useState('')
	const [generatedKeyPair, setGeneratedKeyPair] = useState<VaultKeyPair | null>(null)
	const adminAccess = overview?.adminAccess ?? null
	const vault = overview?.vault.enabled === true ? overview.vault.state : null
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
			if (!nextOverview.vault.enabled) {
				setDeployRecipientsDraft('')
				setGeneratedKeyPair(null)
				return
			}
			if (options.syncDeployRecipientsDraft) {
				setDeployRecipientsDraft(formatRecipientsDraft(nextOverview.vault.state.deploy.recipients))
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
				setError(runtimeErrorMessage(cause, 'Failed to load security state'))
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
		if (!vault) return
		setBusy('vault-deploy-generate')
		try {
			const result = await vaultApi.generateDeployKey()
			setGeneratedKeyPair(result)
			await refresh()
			notify({ color: 'green', message: 'Deploy key generated' })
		} catch (cause) {
			notify({
				color: 'red',
				message: runtimeErrorMessage(cause, 'Failed to generate deploy key'),
			})
		} finally {
			setBusy(null)
		}
	}

	async function saveDeployRecipients() {
		if (!vault) return
		setBusy('vault-deploy-save')
		try {
			const recipients = parseRecipientsDraft(deployRecipientsDraft)
			await vaultApi.setDeployRecipients(recipients)
			await refresh({ syncDeployRecipientsDraft: true })
			notify({ color: 'green', message: 'Deploy recipients saved' })
		} catch (cause) {
			notify({
				color: 'red',
				message: runtimeErrorMessage(cause, 'Failed to save deploy recipients'),
			})
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

	if (error || !overview || !adminAccess) {
		return (
			<ErrorState
				title="Security state unavailable"
				message={error ?? 'The runtime did not return security state.'}
				onRetry={() => void refresh({ syncDeployRecipientsDraft: true })}
			/>
		)
	}

	const failedEvents = events.filter((event) => event.status === 'failure').length
	if (!vault) {
		return (
			<Stack gap="sm" style={{ flex: 1, minHeight: 0 }}>
				<SecurityToolbar
					adminAccess={adminAccess}
					failedEvents={failedEvents}
					namespaceCount={0}
					onRefresh={() => void refresh()}
					refreshing={refreshing}
					totalNamespaces={0}
					vault={null}
				/>
				<EmptyState
					title="Vault 未启用"
					description="当前 Runtime 未安装 Vault capability；管理访问与安全审计仍可使用。"
					minHeight="100%"
				/>
			</Stack>
		)
	}

	const inventory = summarizeInventory(vault)
	const deployRecipientsSaved = formatRecipientsDraft(vault.deploy.recipients)
	const deployRecipientsDirty = deployRecipientsDraft !== deployRecipientsSaved
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
				panes={[
					{
						id: SECURITY_CONTROLS_PANEL_ID,
						defaultSizePercent: securitySplitLayout[SECURITY_CONTROLS_PANEL_ID],
						minSizePercent: 20,
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
					},
					{
						id: SECURITY_NAMESPACE_PANEL_ID,
						defaultSizePercent: securitySplitLayout[SECURITY_NAMESPACE_PANEL_ID],
						minSizePercent: 52,
						children: (
							<NamespaceInventoryPanel
								filteredNamespaces={filteredNamespaces}
								inventory={inventory}
								namespaceSearch={namespaceSearch}
								onNamespaceSearchChange={setNamespaceSearch}
								totalNamespaces={totalNamespaces}
							/>
						),
					},
				]}
			/>
		</Stack>
	)
}
