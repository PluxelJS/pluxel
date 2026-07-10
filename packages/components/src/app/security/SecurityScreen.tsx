import {
	Badge,
	Button,
	Group,
	Loader,
	Paper,
	Stack,
	Table,
	Text,
	Textarea,
	TextInput,
} from '@mantine/core'
import { IconHistory, IconKey, IconRefresh, IconShieldCheck } from '@tabler/icons-react'
import { useEffect, useEffectEvent, useMemo, useState } from 'react'
import {
	getRuntimeSecurityClient,
	type SecurityAuditEvent,
	type SecurityOverview,
	type VaultAdminState,
	type VaultKeyPair,
	rpcErrorMessage,
} from '../../runtime'
import { EmptyState, ErrorState } from '../../components'
import { RouterLinkAdapter } from '../RouterLinkAdapter'
import { useNotify } from '../hooks'
import {
	sanitizeTwoPanelLayout,
	useStoredSplitLayout,
	WorkbenchSplitView,
} from '../workbench/split'

type RefreshOptions = {
	syncDeployRecipientsDraft?: boolean
}

type SecurityBusyKey = 'vault-deploy-generate' | 'vault-deploy-save'

const SECURITY_CONTROLS_PANEL_ID = 'pluxel-security-controls'
const SECURITY_NAMESPACE_PANEL_ID = 'pluxel-security-namespaces'
const SECURITY_SPLIT_LAYOUT_STORAGE_KEY = 'pluxel:security:split'
const DEFAULT_SECURITY_SPLIT_LAYOUT = {
	[SECURITY_CONTROLS_PANEL_ID]: 28,
	[SECURITY_NAMESPACE_PANEL_ID]: 72,
}

function sanitizeSecuritySplitLayout(layout: Record<string, number>) {
	return sanitizeTwoPanelLayout(
		layout,
		DEFAULT_SECURITY_SPLIT_LAYOUT,
		SECURITY_CONTROLS_PANEL_ID,
		20,
		52,
	)
}

const panelStyle = {
	display: 'flex',
	flexDirection: 'column' as const,
	minWidth: 0,
	overflow: 'hidden',
}

const panelStackStyle = {
	flex: 1,
	minHeight: 0,
}

const tableWrapStyle = {
	overflowX: 'auto' as const,
}

const inventoryTableWrapStyle = {
	overflowX: 'auto' as const,
	overflowY: 'auto' as const,
	border: '1px solid var(--mantine-color-default-border)',
	borderRadius: 'var(--mantine-radius-sm)',
	flex: 1,
	minHeight: 0,
}

const sectionHeaderStyle = {
	minHeight: 28,
}

const monoTextStyle = {
	fontFamily: 'var(--mantine-font-family-monospace)',
	overflow: 'hidden',
	textOverflow: 'ellipsis',
	whiteSpace: 'nowrap' as const,
}

function toneForReason(reason?: string): string {
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

function labelForAccessState(adminAccess: SecurityOverview['adminAccess']): string {
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

function labelForVaultState(vault: VaultAdminState): string {
	if (vault.lastError) return 'error'
	if (vault.unlocked) return 'unlocked'
	if (!vault.present) return 'empty'
	return 'sealed'
}

function labelForUnlockSource(source: VaultAdminState['unlockedBy']): string {
	if (source === 'host') return 'host'
	if (source === 'deploy') return 'deploy'
	return '-'
}

function summarizeInventory(vault: VaultAdminState) {
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

function parseRecipientsDraft(input: string): string[] {
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

function formatRecipientsDraft(input: string[]): string {
	return input.join('\n')
}

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

	function applyOverview(nextOverview: SecurityOverview, options: RefreshOptions = {}) {
		setOverview(nextOverview)
		if (options.syncDeployRecipientsDraft) {
			setDeployRecipientsDraft(formatRecipientsDraft(nextOverview.vault.deploy.recipients))
		}
	}

	const refresh = useEffectEvent(async (options: RefreshOptions = {}) => {
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
	})

	useEffect(() => {
		void refresh({ syncDeployRecipientsDraft: true })
	}, [])

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
	return (
		<Stack gap="sm" style={{ flex: 1, minHeight: 0 }}>
			<Paper withBorder p="xs" radius="sm">
				<Group justify="space-between" align="center" wrap="wrap" gap="xs">
					<Group gap={6} wrap="wrap">
						<Badge
							color={adminAccess.allow ? 'green' : toneForReason(adminAccess.reason)}
							variant="light"
						>
							访问 {labelForAccessState(adminAccess)}
						</Badge>
						<Badge
							color={vault.unlocked ? 'green' : vault.lastError ? 'red' : 'blue'}
							variant="light"
						>
							Vault {labelForVaultState(vault)}
						</Badge>
						<Badge color="gray" variant="light">
							Namespace {filteredNamespaces.length} / {vault.namespaces?.length ?? 0}
						</Badge>
						<Badge color={failedEvents > 0 ? 'red' : 'gray'} variant="light">
							审计失败 {failedEvents}
						</Badge>
					</Group>
					<Group gap="xs" wrap="wrap">
						<Button
							component={RouterLinkAdapter}
							to="/security/audit"
							workbenchMode="open-tab"
							leftSection={<IconHistory size={16} />}
							variant="light"
							size="xs"
						>
							打开审计
						</Button>
						<Button
							leftSection={<IconRefresh size={16} />}
							variant="light"
							size="xs"
							loading={refreshing}
							onClick={() => void refresh({ syncDeployRecipientsDraft: !deployRecipientsDirty })}
						>
							刷新
						</Button>
					</Group>
				</Group>
			</Paper>
			<WorkbenchSplitView
				className="plx-workbench__panelGroup"
				defaultLayout={securitySplitLayout}
				id="pluxel-security-split"
				onLayoutChanged={handleSecuritySplitLayoutChanged}
				orientation="horizontal"
				primary={{
					id: SECURITY_CONTROLS_PANEL_ID,
					defaultSize: securitySplitLayout[SECURITY_CONTROLS_PANEL_ID],
					minSize: 20,
					children: (
						<Stack gap="sm" style={{ minHeight: 0 }}>
							<Paper withBorder p="sm" radius="sm" style={panelStyle}>
								<Stack gap="sm">
									<Group justify="space-between" wrap="wrap" style={sectionHeaderStyle}>
										<Group gap="xs">
											<IconKey size={18} />
											<Text fw={700}>部署密钥</Text>
										</Group>
										<Group gap="xs" wrap="nowrap">
											<Badge
												color={vault.deploy.identityPresent ? 'green' : 'gray'}
												variant="light"
											>
												{vault.deploy.env}
											</Badge>
											<Badge color={deployRecipientsDirty ? 'yellow' : 'gray'} variant="light">
												{deployRecipients.length} keys
											</Badge>
										</Group>
									</Group>
									<Textarea
										minRows={3}
										maxRows={5}
										autosize
										value={deployRecipientsDraft}
										onChange={(event) => setDeployRecipientsDraft(event.currentTarget.value)}
										placeholder="age1..."
										styles={{
											input: {
												fontFamily: 'var(--mantine-font-family-monospace)',
												fontSize: 12,
											},
										}}
									/>
									<Group gap="xs">
										<Button
											variant="light"
											size="xs"
											disabled={busy !== null && busy !== 'vault-deploy-generate'}
											loading={busy === 'vault-deploy-generate'}
											onClick={() => void generateDeployKey()}
										>
											生成部署密钥
										</Button>
										<Button
											size="xs"
											disabled={
												!deployRecipientsDirty || (busy !== null && busy !== 'vault-deploy-save')
											}
											loading={busy === 'vault-deploy-save'}
											onClick={() => void saveDeployRecipients()}
										>
											保存接收者
										</Button>
									</Group>
									{generatedKeyPair ? (
										<Textarea
											readOnly
											autosize
											minRows={4}
											maxRows={8}
											label="Generated private key"
											value={generatedKeyPair.privateKey}
											styles={{
												input: {
													fontFamily: 'var(--mantine-font-family-monospace)',
													fontSize: 12,
												},
											}}
										/>
									) : null}
								</Stack>
							</Paper>

							<Paper withBorder p="sm" radius="sm" style={panelStyle}>
								<Stack gap="sm">
									<Group gap="xs">
										<IconShieldCheck size={18} />
										<Text fw={700}>访问状态</Text>
									</Group>
									<div style={tableWrapStyle}>
										<Table verticalSpacing={3}>
											<Table.Tbody>
												<Table.Tr>
													<Table.Td>暴露级别</Table.Td>
													<Table.Td>{adminAccess.exposure}</Table.Td>
												</Table.Tr>
												<Table.Tr>
													<Table.Td>Provider</Table.Td>
													<Table.Td>{adminAccess.provider}</Table.Td>
												</Table.Tr>
												<Table.Tr>
													<Table.Td>Issuer</Table.Td>
													<Table.Td>
														<Text size="sm" style={monoTextStyle}>
															{adminAccess.issuer ?? '-'}
														</Text>
													</Table.Td>
												</Table.Tr>
												<Table.Tr>
													<Table.Td>Token Header</Table.Td>
													<Table.Td>
														<Text size="sm" style={monoTextStyle}>
															{adminAccess.tokenHeader ?? '-'}
														</Text>
													</Table.Td>
												</Table.Tr>
												<Table.Tr>
													<Table.Td>解锁来源</Table.Td>
													<Table.Td>{labelForUnlockSource(vault.unlockedBy)}</Table.Td>
												</Table.Tr>
												<Table.Tr>
													<Table.Td>Host Identity</Table.Td>
													<Table.Td>{vault.hostIdentityPresent ? 'ready' : 'missing'}</Table.Td>
												</Table.Tr>
											</Table.Tbody>
										</Table>
									</div>
									{adminAccess.requiredClaims ? (
										<Text size="xs" c="dimmed" style={monoTextStyle}>
											Claims: {JSON.stringify(adminAccess.requiredClaims)}
										</Text>
									) : null}
									{vault.lastError ? (
										<Text size="sm" c="red">
											{vault.lastError.message}
										</Text>
									) : null}
								</Stack>
							</Paper>
						</Stack>
					),
				}}
				secondary={{
					id: SECURITY_NAMESPACE_PANEL_ID,
					defaultSize: securitySplitLayout[SECURITY_NAMESPACE_PANEL_ID],
					minSize: 52,
					children: (
						<Paper withBorder p="sm" radius="sm" style={panelStyle}>
							<Stack gap="sm" style={panelStackStyle}>
								<Group
									justify="space-between"
									align="center"
									wrap="wrap"
									gap="xs"
									style={sectionHeaderStyle}
								>
									<Group gap="xs">
										<Text fw={700}>Namespace 库存</Text>
										<Badge variant="light" color="gray">
											{filteredNamespaces.length} / {vault.namespaces?.length ?? 0}
										</Badge>
										<Badge variant="light" color="gray">
											{inventory.kv} KV / {inventory.docs} Docs / {inventory.blobs} Blobs
										</Badge>
									</Group>
									<TextInput
										size="xs"
										placeholder="搜索 namespace"
										value={namespaceSearch}
										onChange={(event) => setNamespaceSearch(event.currentTarget.value)}
										style={{ width: 220, maxWidth: '100%' }}
									/>
								</Group>
								{vault.namespaces?.length ? (
									<div style={inventoryTableWrapStyle}>
										<Table striped highlightOnHover withColumnBorders={false} verticalSpacing={6}>
											<Table.Thead>
												<Table.Tr>
													<Table.Th>Namespace</Table.Th>
													<Table.Th>KV</Table.Th>
													<Table.Th>Docs</Table.Th>
													<Table.Th>Blobs</Table.Th>
												</Table.Tr>
											</Table.Thead>
											<Table.Tbody>
												{filteredNamespaces.length > 0 ? (
													filteredNamespaces.map((row) => (
														<Table.Tr key={row.namespace}>
															<Table.Td>
																<Text size="sm" style={monoTextStyle}>
																	{row.namespace}
																</Text>
															</Table.Td>
															<Table.Td>{row.kvKeys}</Table.Td>
															<Table.Td>{row.docDocuments}</Table.Td>
															<Table.Td>{row.blobs}</Table.Td>
														</Table.Tr>
													))
												) : (
													<Table.Tr>
														<Table.Td colSpan={4}>
															<Text size="sm" c="dimmed">
																无匹配 namespace
															</Text>
														</Table.Td>
													</Table.Tr>
												)}
											</Table.Tbody>
										</Table>
									</div>
								) : (
									<EmptyState title="暂无库存" description="有可读库存时会列出命名空间统计。" />
								)}
							</Stack>
						</Paper>
					),
				}}
			/>
		</Stack>
	)
}
