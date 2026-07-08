import {
	Badge,
	Button,
	Divider,
	Group,
	Loader,
	Paper,
	Stack,
	Table,
	Text,
	Textarea,
	Title,
} from '@mantine/core'
import { IconRefresh, IconShieldLock } from '@tabler/icons-react'
import { useEffect, useEffectEvent, useState } from 'react'
import {
	getRuntimeSecurityClient,
	type SecurityAuditEvent,
	type SecurityOverview,
	type VaultAdminState,
	type VaultKeyPair,
	rpcErrorMessage,
} from '../../runtime'
import { EmptyState, ErrorState } from '../../components'
import { useNotify } from '../hooks'

type RefreshOptions = {
	syncDeployRecipientsDraft?: boolean
}

const eventTimeFormatter = new Intl.DateTimeFormat(undefined, {
	dateStyle: 'short',
	timeStyle: 'short',
})

const pageGridStyle = {
	display: 'grid',
	gap: 12,
	gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))',
	alignItems: 'start',
}

const summaryGridStyle = {
	display: 'grid',
	gap: 10,
	gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
}

const summaryCardStyle = {
	padding: '10px 12px',
	border: '1px solid var(--mantine-color-default-border)',
	borderRadius: 'var(--mantine-radius-sm)',
	background: 'var(--mantine-color-body)',
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

function toneForEventStatus(status: SecurityAuditEvent['status']): string {
	switch (status) {
		case 'success':
			return 'green'
		case 'failure':
			return 'red'
		default:
			return 'blue'
	}
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
	const [busy, setBusy] = useState<string | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [deployRecipientsDraft, setDeployRecipientsDraft] = useState('')
	const [generatedKeyPair, setGeneratedKeyPair] = useState<VaultKeyPair | null>(null)
	const adminAccess = overview?.adminAccess ?? null
	const vault = overview?.vault ?? null

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

	async function unlockVault() {
		setBusy('vault-unlock')
		try {
			await vaultApi.unlock()
			await refresh()
			notify({ color: 'green', message: 'Vault unlocked' })
		} catch (cause) {
			notify({ color: 'red', message: rpcErrorMessage(cause, 'Failed to unlock vault') })
		} finally {
			setBusy(null)
		}
	}

	async function ensureHostKey() {
		setBusy('vault-host-key')
		try {
			const result = await vaultApi.ensureHostKey()
			await refresh()
			notify({ color: 'green', message: `Host key ready: ${result.publicKey.slice(0, 20)}...` })
		} catch (cause) {
			notify({ color: 'red', message: rpcErrorMessage(cause, 'Failed to prepare host key') })
		} finally {
			setBusy(null)
		}
	}

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

	return (
		<Stack gap="md">
			<Group justify="space-between" align="center">
				<div>
					<Title order={2}>Security</Title>
					<Text c="dimmed" size="sm">
						Management admin gate and encrypted storage state.
					</Text>
				</div>
				<Button
					leftSection={<IconRefresh size={16} />}
					variant="light"
					loading={refreshing}
					onClick={() => void refresh({ syncDeployRecipientsDraft: true })}
				>
					Refresh
				</Button>
			</Group>

			<div style={pageGridStyle}>
				<Paper withBorder p="md" radius="sm">
					<Stack gap="sm">
						<Group justify="space-between">
							<Group gap="xs">
								<IconShieldLock size={18} />
								<Title order={3}>Access</Title>
							</Group>
							<Badge color={adminAccess.allow ? 'green' : toneForReason(adminAccess.reason)}>
								{labelForAccessState(adminAccess)}
							</Badge>
						</Group>
						<Divider />
						<div style={summaryGridStyle}>
							<div style={summaryCardStyle}>
								<Text size="xs" c="dimmed" fw={700}>
									Exposure
								</Text>
								<Text fw={700}>{adminAccess.exposure}</Text>
							</div>
							<div style={summaryCardStyle}>
								<Text size="xs" c="dimmed" fw={700}>
									Provider
								</Text>
								<Text fw={700}>{adminAccess.provider}</Text>
							</div>
							<div style={summaryCardStyle}>
								<Text size="xs" c="dimmed" fw={700}>
									Issuer
								</Text>
								<Text fw={700}>{adminAccess.issuer ?? '-'}</Text>
							</div>
							<div style={summaryCardStyle}>
								<Text size="xs" c="dimmed" fw={700}>
									Token Header
								</Text>
								<Text fw={700}>{adminAccess.tokenHeader ?? '-'}</Text>
							</div>
						</div>
						{adminAccess.requiredClaims ? (
							<Text size="sm" c="dimmed">
								Admin claims: {JSON.stringify(adminAccess.requiredClaims)}
							</Text>
						) : null}
					</Stack>
				</Paper>

				<Paper withBorder p="md" radius="sm">
					<Stack gap="sm">
						<Group justify="space-between">
							<Title order={3}>Vault</Title>
							<Badge color={vault.unlocked ? 'green' : vault.lastError ? 'red' : 'blue'}>
								{labelForVaultState(vault)}
							</Badge>
						</Group>
						<Divider />
						<div style={summaryGridStyle}>
							<div style={summaryCardStyle}>
								<Text size="xs" c="dimmed" fw={700}>
									Unlocked By
								</Text>
								<Text fw={700}>{labelForUnlockSource(vault.unlockedBy)}</Text>
							</div>
							<div style={summaryCardStyle}>
								<Text size="xs" c="dimmed" fw={700}>
									Namespaces
								</Text>
								<Text fw={700}>{inventory.namespaces}</Text>
							</div>
							<div style={summaryCardStyle}>
								<Text size="xs" c="dimmed" fw={700}>
									KV / Docs / Blobs
								</Text>
								<Text fw={700}>
									{inventory.kv} / {inventory.docs} / {inventory.blobs}
								</Text>
							</div>
						</div>
						{vault.lastError ? (
							<Text size="sm" c="red">
								{vault.lastError.message}
							</Text>
						) : null}
						<Group>
							<Button
								variant="light"
								loading={busy === 'vault-unlock'}
								onClick={() => void unlockVault()}
							>
								Unlock
							</Button>
							<Button
								variant="light"
								loading={busy === 'vault-host-key'}
								onClick={() => void ensureHostKey()}
							>
								Host Key
							</Button>
						</Group>
					</Stack>
				</Paper>
			</div>

			<Paper withBorder p="md" radius="sm">
				<Stack gap="sm">
					<Group justify="space-between">
						<Title order={3}>Deploy Recipients</Title>
						<Group>
							<Button
								variant="light"
								loading={busy === 'vault-deploy-generate'}
								onClick={() => void generateDeployKey()}
							>
								Generate Key
							</Button>
							<Button
								loading={busy === 'vault-deploy-save'}
								onClick={() => void saveDeployRecipients()}
							>
								Save
							</Button>
						</Group>
					</Group>
					<Textarea
						minRows={4}
						value={deployRecipientsDraft}
						onChange={(event) => setDeployRecipientsDraft(event.currentTarget.value)}
						placeholder="age1..."
					/>
					{generatedKeyPair ? (
						<Textarea
							readOnly
							minRows={5}
							label="Generated private key"
							value={generatedKeyPair.privateKey}
						/>
					) : null}
				</Stack>
			</Paper>

			<Paper withBorder p="md" radius="sm">
				<Stack gap="sm">
					<Title order={3}>Audit Events</Title>
					{events.length === 0 ? (
						<EmptyState title="No events" description="Security events will appear here." />
					) : (
						<Table striped highlightOnHover>
							<Table.Thead>
								<Table.Tr>
									<Table.Th>Time</Table.Th>
									<Table.Th>Area</Table.Th>
									<Table.Th>Action</Table.Th>
									<Table.Th>Status</Table.Th>
									<Table.Th>Message</Table.Th>
								</Table.Tr>
							</Table.Thead>
							<Table.Tbody>
								{events.map((event) => (
									<Table.Tr key={event.id}>
										<Table.Td>{eventTimeFormatter.format(new Date(event.at))}</Table.Td>
										<Table.Td>{event.area}</Table.Td>
										<Table.Td>{event.action}</Table.Td>
										<Table.Td>
											<Badge color={toneForEventStatus(event.status)}>{event.status}</Badge>
										</Table.Td>
										<Table.Td>{event.message ?? event.reason ?? '-'}</Table.Td>
									</Table.Tr>
								))}
							</Table.Tbody>
						</Table>
					)}
				</Stack>
			</Paper>
		</Stack>
	)
}
