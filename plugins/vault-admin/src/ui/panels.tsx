import { Badge, Button, Group, Paper, Stack, Table, Text, Textarea, TextInput } from '@mantine/core'
import { IconKey } from '@tabler/icons-react'
import type { VaultSnapshot, SecurityBusyKey } from './model.ts'
import type { VaultKeyPair } from '@pluxel/services/vault'
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

interface DeployKeyPanelProps {
	busy: SecurityBusyKey | null
	deployRecipients: string[]
	deployRecipientsDirty: boolean
	deployRecipientsDraft: string
	generatedKeyPair: VaultKeyPair | null
	onDeployRecipientsDraftChange: (value: string) => void
	onGenerateDeployKey: () => void
	onSaveDeployRecipients: () => void
	vault: VaultSnapshot
}

export function DeployKeyPanel({
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

interface NamespaceInventoryPanelProps {
	filteredNamespaces: VaultSnapshot['namespaces']
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
					<Text c="dimmed">暂无库存；有可读库存时会列出命名空间统计。</Text>
				)}
			</Stack>
		</Paper>
	)
}
