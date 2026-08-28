import { Badge, Button, Group, Paper, Stack, Table, Text, Textarea, TextInput } from '@mantine/core'
import { IconHistory, IconKey, IconRefresh, IconShieldCheck } from '@tabler/icons-react'
import type { SecurityOverview, VaultAdminState, VaultKeyPair } from '../../runtime'
import { EmptyState } from '../../components'
import { RouterLinkAdapter } from '../RouterLinkAdapter'
import {
	labelForAccessState,
	labelForUnlockSource,
	labelForVaultState,
	type SecurityBusyKey,
} from './securityModel'

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

interface SecurityToolbarProps {
	adminAccess: SecurityOverview['adminAccess']
	failedEvents: number
	namespaceCount: number
	onRefresh: () => void
	refreshing: boolean
	totalNamespaces: number
	vault: VaultAdminState | null
}

export function SecurityToolbar({
	adminAccess,
	failedEvents,
	namespaceCount,
	onRefresh,
	refreshing,
	totalNamespaces,
	vault,
}: SecurityToolbarProps) {
	return (
		<Paper withBorder p="xs" radius="sm">
			<Group justify="space-between" align="center" wrap="wrap" gap="xs">
				<Group gap={6} wrap="wrap">
					<Badge color={adminAccess.provider?.ready ? 'green' : 'orange'} variant="light">
						访问 {labelForAccessState(adminAccess)}
					</Badge>
					{vault ? (
						<>
							<Badge
								color={vault.unlocked ? 'green' : vault.lastError ? 'red' : 'blue'}
								variant="light"
							>
								Vault {labelForVaultState(vault)}
							</Badge>
							<Badge color="gray" variant="light">
								Namespace {namespaceCount} / {totalNamespaces}
							</Badge>
						</>
					) : (
						<Badge color="gray" variant="light">
							Vault disabled
						</Badge>
					)}
					<Badge color={failedEvents > 0 ? 'red' : 'gray'} variant="light">
						审计失败 {failedEvents}
					</Badge>
				</Group>
				<Group gap="xs" wrap="wrap">
					<Button
						component={RouterLinkAdapter}
						to="/security/audit"
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
						onClick={onRefresh}
					>
						刷新
					</Button>
				</Group>
			</Group>
		</Paper>
	)
}

interface SecurityControlsPaneProps {
	adminAccess: SecurityOverview['adminAccess']
	busy: SecurityBusyKey | null
	deployRecipients: string[]
	deployRecipientsDirty: boolean
	deployRecipientsDraft: string
	generatedKeyPair: VaultKeyPair | null
	onDeployRecipientsDraftChange: (value: string) => void
	onGenerateDeployKey: () => void
	onSaveDeployRecipients: () => void
	vault: VaultAdminState
}

export function SecurityControlsPane({
	adminAccess,
	busy,
	deployRecipients,
	deployRecipientsDirty,
	deployRecipientsDraft,
	generatedKeyPair,
	onDeployRecipientsDraftChange,
	onGenerateDeployKey,
	onSaveDeployRecipients,
	vault,
}: SecurityControlsPaneProps) {
	return (
		<Stack gap="sm" style={{ minHeight: 0 }}>
			<DeployKeyPanel
				busy={busy}
				deployRecipients={deployRecipients}
				deployRecipientsDirty={deployRecipientsDirty}
				deployRecipientsDraft={deployRecipientsDraft}
				generatedKeyPair={generatedKeyPair}
				onDeployRecipientsDraftChange={onDeployRecipientsDraftChange}
				onGenerateDeployKey={onGenerateDeployKey}
				onSaveDeployRecipients={onSaveDeployRecipients}
				vault={vault}
			/>
			<AccessStatusPanel adminAccess={adminAccess} vault={vault} />
		</Stack>
	)
}

interface DeployKeyPanelProps {
	busy: SecurityBusyKey | null
	deployRecipients: string[]
	deployRecipientsDirty: boolean
	deployRecipientsDraft: string
	generatedKeyPair: VaultKeyPair | null
	onDeployRecipientsDraftChange: (value: string) => void
	onGenerateDeployKey: () => void
	onSaveDeployRecipients: () => void
	vault: VaultAdminState
}

function DeployKeyPanel({
	busy,
	deployRecipients,
	deployRecipientsDirty,
	deployRecipientsDraft,
	generatedKeyPair,
	onDeployRecipientsDraftChange,
	onGenerateDeployKey,
	onSaveDeployRecipients,
	vault,
}: DeployKeyPanelProps) {
	return (
		<Paper withBorder p="sm" radius="sm" style={panelStyle}>
			<Stack gap="sm">
				<Group justify="space-between" wrap="wrap" style={sectionHeaderStyle}>
					<Group gap="xs">
						<IconKey size={18} />
						<Text fw={700}>部署密钥</Text>
					</Group>
					<Group gap="xs" wrap="nowrap">
						<Badge color={vault.deploy.identityPresent ? 'green' : 'gray'} variant="light">
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
					onChange={(event) => onDeployRecipientsDraftChange(event.currentTarget.value)}
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
						onClick={onGenerateDeployKey}
					>
						生成部署密钥
					</Button>
					<Button
						size="xs"
						disabled={!deployRecipientsDirty || (busy !== null && busy !== 'vault-deploy-save')}
						loading={busy === 'vault-deploy-save'}
						onClick={onSaveDeployRecipients}
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
	)
}

interface AccessStatusPanelProps {
	adminAccess: SecurityOverview['adminAccess']
	vault: VaultAdminState
}

function AccessStatusPanel({ adminAccess, vault }: AccessStatusPanelProps) {
	return (
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
								<Table.Td>访问策略</Table.Td>
								<Table.Td>{adminAccess.policy}</Table.Td>
							</Table.Tr>
							<Table.Tr>
								<Table.Td>Provider</Table.Td>
								<Table.Td>{adminAccess.provider?.label ?? 'none'}</Table.Td>
							</Table.Tr>
							<Table.Tr>
								<Table.Td>认证模式</Table.Td>
								<Table.Td>
									<Text size="sm" style={monoTextStyle}>
										{adminAccess.provider?.method ?? '-'}
									</Text>
								</Table.Td>
							</Table.Tr>
							<Table.Tr>
								<Table.Td>远程状态</Table.Td>
								<Table.Td>
									<Text size="sm" style={monoTextStyle}>
										{adminAccess.provider?.ready ? 'ready' : 'local setup required'}
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
				{vault.lastError ? (
					<Text size="sm" c="red">
						{vault.lastError.message}
					</Text>
				) : null}
			</Stack>
		</Paper>
	)
}

interface NamespaceInventoryPanelProps {
	filteredNamespaces: VaultAdminState['namespaces']
	inventory: {
		blobs: number
		docs: number
		kv: number
		namespaces: number
	}
	namespaceSearch: string
	onNamespaceSearchChange: (value: string) => void
	totalNamespaces: number
}

export function NamespaceInventoryPanel({
	filteredNamespaces,
	inventory,
	namespaceSearch,
	onNamespaceSearchChange,
	totalNamespaces,
}: NamespaceInventoryPanelProps) {
	return (
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
							{filteredNamespaces.length} / {totalNamespaces}
						</Badge>
						<Badge variant="light" color="gray">
							{inventory.kv} KV / {inventory.docs} Docs / {inventory.blobs} Blobs
						</Badge>
					</Group>
					<TextInput
						size="xs"
						placeholder="搜索 namespace"
						value={namespaceSearch}
						onChange={(event) => onNamespaceSearchChange(event.currentTarget.value)}
						style={{ width: 220, maxWidth: '100%' }}
					/>
				</Group>
				{totalNamespaces ? (
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
	)
}
