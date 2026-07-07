import {
	Alert,
	Badge,
	Button,
	Card,
	Code,
	CopyButton,
	Group,
	PasswordInput,
	ScrollArea,
	Stack,
	Table,
	TagsInput,
	Text,
	TextInput,
	Title,
} from '@mantine/core'
import { rpcErrorMessage } from '@pluxel/runtime/web/ui'
import { IconCheck, IconCopy, IconTrash } from '@tabler/icons-react'
import { useMemo, useState } from 'react'
import type { GatewayTokenCreateInput, GatewayTokenDoc } from '../contracts'
import { gatewayPlugin } from './runtime'

type GatewayUiApp = {
	rpc: {
		createToken(input: GatewayTokenCreateInput): Promise<GatewayTokenDoc>
		revokeToken(id: string): Promise<{ ok: true }>
		rpcBase(): Promise<string>
	}
	db: {
		useList(
			collection: 'tokens',
			spec?: { limit?: number; sort?: Partial<Record<keyof GatewayTokenDoc, 1 | -1>> },
		): GatewayTokenDoc[]
	}
}

function useGatewayApp(): GatewayUiApp {
	return gatewayPlugin.use() as unknown as GatewayUiApp
}

export function GatewayDashboard() {
	return (
		<Stack gap="lg" p="md">
			<Group justify="space-between">
				<Stack gap={2}>
					<Title order={3}>External Gateway RPC</Title>
					<Text size="sm" c="dimmed">
						外部系统通过 Cap&apos;n Web RPC 认证后调用 adapter capability
					</Text>
				</Stack>
				<Badge variant="light">Cap&apos;n Web</Badge>
			</Group>
			<GatewayPanel />
		</Stack>
	)
}

export function GatewayPanel() {
	const app = useGatewayApp()
	const tokens = app.db.useList('tokens', { limit: 100, sort: { updatedAt: -1 } })
	const [name, setName] = useState('zhipu-client')
	const [token, setToken] = useState('')
	const [permissions, setPermissions] = useState<string[]>(['zhipu:*'])
	const [error, setError] = useState<string | null>(null)
	const rpcPath = '/__pluxel/plugins/ExternalGatewayPlugin/gateway/rpc'

	const create = async () => {
		try {
			await app.rpc.createToken({
				name,
				token,
				permissions: permissions as GatewayTokenCreateInput['permissions'],
			})
			setToken('')
			setError(null)
		} catch (caught) {
			setError(rpcErrorMessage(caught, '创建 token 失败'))
		}
	}

	const revoke = async (id: string) => {
		try {
			await app.rpc.revokeToken(id)
			setError(null)
		} catch (caught) {
			setError(rpcErrorMessage(caught, '撤销 token 失败'))
		}
	}

	return (
		<Stack gap="md">
			<Card withBorder radius="md" p="lg">
				<Stack gap="md">
					<Group justify="space-between">
						<Title order={4}>RPC 入口</Title>
						<CopyButton value={rpcPath}>
							{({ copied, copy }) => (
								<Button variant="light" leftSection={<IconCopy size={16} />} onClick={copy}>
									{copied ? '已复制' : '复制路径'}
								</Button>
							)}
						</CopyButton>
					</Group>
					<Code block>{rpcPath}</Code>
					<Text size="sm" c="dimmed">
						默认开发 token：<Code>dev-zhipu-token-change-me</Code>
						，生产应通过环境变量或本页重新创建。
					</Text>
				</Stack>
			</Card>
			<Card withBorder radius="md" p="lg">
				<Stack gap="md">
					<Title order={4}>创建外部访问 Token</Title>
					{error ? <Alert color="red">{error}</Alert> : null}
					<TextInput
						label="名称"
						value={name}
						onChange={(event) => setName(event.currentTarget.value)}
					/>
					<PasswordInput
						label="Token"
						placeholder="至少 12 个字符"
						value={token}
						onChange={(event) => setToken(event.currentTarget.value)}
					/>
					<TagsInput label="权限" value={permissions} onChange={setPermissions} />
					<Button
						leftSection={<IconCheck size={16} />}
						disabled={!token.trim()}
						onClick={() => void create()}
					>
						保存 Token
					</Button>
				</Stack>
			</Card>
			<TokenTable tokens={tokens} onRevoke={revoke} />
		</Stack>
	)
}

function TokenTable({
	tokens,
	onRevoke,
}: {
	tokens: GatewayTokenDoc[]
	onRevoke: (id: string) => Promise<void>
}) {
	const rows = useMemo(
		() =>
			tokens.map((token) => (
				<Table.Tr key={token.id}>
					<Table.Td>{token.name}</Table.Td>
					<Table.Td>
						<Code>{token.tokenPreview}</Code>
					</Table.Td>
					<Table.Td>{token.permissions.join(', ')}</Table.Td>
					<Table.Td>
						<Badge color={token.enabled ? 'teal' : 'gray'} variant="light">
							{token.enabled ? 'enabled' : 'revoked'}
						</Badge>
					</Table.Td>
					<Table.Td>
						{token.lastUsedAt ? new Date(token.lastUsedAt).toLocaleString() : '-'}
					</Table.Td>
					<Table.Td>
						<Button
							variant="subtle"
							color="red"
							size="xs"
							leftSection={<IconTrash size={14} />}
							disabled={!token.enabled}
							onClick={() => void onRevoke(token.id)}
						>
							撤销
						</Button>
					</Table.Td>
				</Table.Tr>
			)),
		[tokens, onRevoke],
	)

	return (
		<Card withBorder radius="md" p="md">
			<Stack gap="sm">
				<Title order={5}>Tokens</Title>
				<ScrollArea h={320} type="auto">
					<Table striped highlightOnHover>
						<Table.Thead>
							<Table.Tr>
								<Table.Th>名称</Table.Th>
								<Table.Th>预览</Table.Th>
								<Table.Th>权限</Table.Th>
								<Table.Th>状态</Table.Th>
								<Table.Th>最近使用</Table.Th>
								<Table.Th />
							</Table.Tr>
						</Table.Thead>
						<Table.Tbody>{rows}</Table.Tbody>
					</Table>
				</ScrollArea>
			</Stack>
		</Card>
	)
}
