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
	Text,
	TextInput,
	Title,
} from '@mantine/core'
import { rpcErrorMessage } from '@pluxel/runtime/web/ui'
import { IconCheck, IconCopy, IconRefresh, IconTrash } from '@tabler/icons-react'
import { useMemo, useState } from 'react'
import type {
	GatewayTokenCreateInput,
	GatewayTokenDoc,
} from '@repo/external-api-gateway-shared/gateway'
import { gatewayPlugin } from './runtime'

type GatewayUiApp = {
	rpc: {
		createToken(input: GatewayTokenCreateInput): Promise<GatewayTokenDoc>
		revokeToken(id: string): Promise<{ ok: true }>
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
						外部系统通过 Cap&apos;n Web RPC 认证后调用稳定 tool
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
	const [error, setError] = useState<string | null>(null)
	const rpcPath = '/__pluxel/plugins/ExternalGatewayPlugin/gateway/rpc'

	const create = async () => {
		try {
			await app.rpc.createToken({
				name,
				token,
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
						本地开发会自动创建一个默认 token；生产环境应通过环境变量或本页创建专用 token。
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
					<Group>
						<Button
							variant="light"
							leftSection={<IconRefresh size={16} />}
							onClick={() => setToken(generateToken())}
						>
							生成 Token
						</Button>
						<Button
							leftSection={<IconCheck size={16} />}
							disabled={!token.trim()}
							onClick={() => void create()}
						>
							保存 Token
						</Button>
					</Group>
				</Stack>
			</Card>
			<TokenTable tokens={tokens} onRevoke={revoke} />
		</Stack>
	)
}

function generateToken(): string {
	const bytes = new Uint8Array(32)
	crypto.getRandomValues(bytes)
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
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
