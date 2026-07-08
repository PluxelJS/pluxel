import {
	Alert,
	Badge,
	Box,
	Button,
	Card,
	Code,
	CopyButton,
	Grid,
	Group,
	JsonInput,
	PasswordInput,
	ScrollArea,
	Select,
	Stack,
	Table,
	Text,
	TextInput,
	Title,
} from '@mantine/core'
import { rpcErrorMessage } from '@pluxel/runtime/web/ui'
import { IconCheck, IconKey, IconPlayerPlay, IconSearch, IconTrash } from '@tabler/icons-react'
import {
	getYiqichaApi,
	parseParameters,
	yiqichaCatalog,
	type YiqichaApi,
} from '@repo/external-api-gateway-yiqicha-catalog'
import { useEffect, useMemo, useRef, useState } from 'react'
import { DEFAULT_YIQICHA_BASE_URL } from '@repo/external-api-gateway-shared/constants'
import type { YiqichaSettingsDoc, YiqichaStatusDoc, YiqichaTestRunDoc } from '../contracts'
import { yiqichaPlugin } from './runtime'

type YiqichaUiApp = {
	pluginName: 'YiqichaProviderPlugin'
	rpc: {
		saveSettings(input: {
			appkey?: string
			secretKey?: string
			baseUrl?: string
		}): Promise<YiqichaSettingsDoc>
		clearSecrets(): Promise<YiqichaSettingsDoc>
		testConnection(input?: {
			userId?: string
			api?: string
			keyword?: string
		}): Promise<{ ok: boolean; message: string }>
		clearHistory(): Promise<{ ok: true }>
	}
	db: {
		useDocById(collection: 'settings', id: 'settings'): YiqichaSettingsDoc | undefined
		useDocById(collection: 'status', id: 'status'): YiqichaStatusDoc | undefined
		useList(
			collection: 'history',
			spec?: { limit?: number; sort?: Partial<Record<keyof YiqichaTestRunDoc, 1 | -1>> },
		): YiqichaTestRunDoc[]
	}
}

type RequestState = {
	loading: boolean
	error: string | null
	result: unknown
}

function useYiqichaApp(): YiqichaUiApp {
	return yiqichaPlugin.use() as unknown as YiqichaUiApp
}

function pluginRoute(pluginName: string, path: string) {
	return `/__pluxel/plugins/${encodeURIComponent(pluginName)}/yiqicha${path}`
}

function jsonPretty(input: unknown): string {
	if (input === undefined || input === null) return ''
	if (typeof input === 'string') return input
	return JSON.stringify(input, null, 2)
}

function parseJsonObject(input: string): Record<string, unknown> {
	const trimmed = input.trim()
	if (!trimmed) return {}
	const parsed = JSON.parse(trimmed)
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new Error('JSON 必须是对象')
	}
	return parsed as Record<string, unknown>
}

function truncateText(input: string | undefined, length = 120): string {
	if (!input) return '-'
	return input.length > length ? `${input.slice(0, length)}...` : input
}

function settingsBadge(settings: YiqichaSettingsDoc | undefined): string | null {
	if (!settings) return '加载中'
	if (settings.hasAppkey && settings.hasSecretKey) return settings.appkeyPreview
	if (settings.hasAppkey) return '缺 Secret'
	if (settings.hasSecretKey) return '缺 App Key'
	return '未配置'
}

function apiSelectLabel(api: YiqichaApi): string {
	return `${api.apiCode} · ${api.apiName} · ${api.cateName}`
}

const DEFAULT_API_CODE = '1000'
const API_OPTIONS = yiqichaCatalog.apis.map((api) => ({
	value: api.apiCode,
	label: apiSelectLabel(api),
}))

export function YiqichaDashboard() {
	return (
		<Stack gap="lg" p="md">
			<Group justify="space-between" align="center">
				<Stack gap={2}>
					<Title order={3}>YiQiCha Provider</Title>
					<Text size="sm" c="dimmed">
						亿企查 OpenAPI provider，调用会自动写入 Usage Billing
					</Text>
				</Stack>
				<Badge variant="light">{yiqichaCatalog.apis.length} APIs</Badge>
			</Group>
			<Grid>
				<Grid.Col span={{ base: 12, md: 4 }}>
					<YiqichaSettingsPanel compact />
				</Grid.Col>
				<Grid.Col span={{ base: 12, md: 8 }}>
					<YiqichaApiPanel />
				</Grid.Col>
			</Grid>
			<YiqichaHistoryPanel />
		</Stack>
	)
}

export function YiqichaSettingsPanel({ compact = false }: { compact?: boolean }) {
	const app = useYiqichaApp()
	const settings = app.db.useDocById('settings', 'settings')
	const status = app.db.useDocById('status', 'status')
	const [appkey, setAppkey] = useState('')
	const [secretKey, setSecretKey] = useState('')
	const [baseUrl, setBaseUrl] = useState(DEFAULT_YIQICHA_BASE_URL)
	const baseUrlEdited = useRef(false)
	const [testUserId, setTestUserId] = useState('system')
	const [testKeyword, setTestKeyword] = useState('亿企查科技有限公司')
	const [error, setError] = useState<string | null>(null)
	const [message, setMessage] = useState<string | null>(null)

	useEffect(() => {
		if (baseUrlEdited.current) return
		setBaseUrl(settings?.baseUrl ?? DEFAULT_YIQICHA_BASE_URL)
	}, [settings?.baseUrl])

	const run = async <T,>(action: () => Promise<T>, fallback: string): Promise<T | undefined> => {
		try {
			const result = await action()
			setError(null)
			return result
		} catch (caught) {
			setError(rpcErrorMessage(caught, fallback))
			return undefined
		}
	}

	const save = async () => {
		const result = await run(
			() =>
				app.rpc.saveSettings({
					appkey: appkey.trim() || undefined,
					secretKey: secretKey.trim() || undefined,
					baseUrl,
				}),
			'保存设置失败',
		)
		if (result) {
			setAppkey('')
			setSecretKey('')
			baseUrlEdited.current = false
			setBaseUrl(result.baseUrl)
			setMessage('设置已保存')
		}
	}

	const test = async () => {
		const result = await run(
			() =>
				app.rpc.testConnection({ userId: testUserId, api: DEFAULT_API_CODE, keyword: testKeyword }),
			'测试调用失败',
		)
		if (result) setMessage(result.message)
	}

	return (
		<Card withBorder radius="md" p={compact ? 'md' : 'lg'}>
			<Stack gap="md">
				<Group justify="space-between">
					<Group gap="xs">
						<IconKey size={18} />
						<Title order={compact ? 5 : 4}>YiQiCha 设置</Title>
					</Group>
					<Badge
						color={settings?.hasAppkey && settings?.hasSecretKey ? 'teal' : 'gray'}
						variant="light"
					>
						{settingsBadge(settings)}
					</Badge>
				</Group>
				{error ? <Alert color="red">{error}</Alert> : null}
				{message ? (
					<Alert color={status?.lastOk === false ? 'yellow' : 'green'}>{message}</Alert>
				) : null}
				<PasswordInput
					label="App Key"
					placeholder="填入 YiQiCha appkey"
					value={appkey}
					onChange={(event) => setAppkey(event.currentTarget.value)}
				/>
				<PasswordInput
					label="Secret Key"
					placeholder="填入 YiQiCha secretKey"
					value={secretKey}
					onChange={(event) => setSecretKey(event.currentTarget.value)}
				/>
				<TextInput
					label="Base URL"
					value={baseUrl}
					onChange={(event) => {
						baseUrlEdited.current = true
						setBaseUrl(event.currentTarget.value)
					}}
				/>
				<Grid>
					<Grid.Col span={{ base: 12, sm: 5 }}>
						<TextInput
							label="测试 userId"
							value={testUserId}
							onChange={(event) => setTestUserId(event.currentTarget.value)}
						/>
					</Grid.Col>
					<Grid.Col span={{ base: 12, sm: 7 }}>
						<TextInput
							label="测试关键词"
							value={testKeyword}
							onChange={(event) => setTestKeyword(event.currentTarget.value)}
						/>
					</Grid.Col>
				</Grid>
				<Group>
					<Button leftSection={<IconCheck size={16} />} onClick={() => void save()}>
						保存
					</Button>
					<Button
						variant="light"
						leftSection={<IconPlayerPlay size={16} />}
						onClick={() => void test()}
					>
						测试接口
					</Button>
					<Button
						variant="subtle"
						color="red"
						leftSection={<IconTrash size={16} />}
						onClick={() => void run(() => app.rpc.clearSecrets(), '清除凭据失败')}
					>
						清除
					</Button>
				</Group>
				<Text size="xs" c="dimmed">
					最近状态：<Code>{status?.lastStatus ?? 'idle'}</Code>
				</Text>
			</Stack>
		</Card>
	)
}

export function YiqichaApiPanel() {
	const app = useYiqichaApp()
	const settings = app.db.useDocById('settings', 'settings')
	const [apiCode, setApiCode] = useState(DEFAULT_API_CODE)
	const api = getYiqichaApi(apiCode) ?? getYiqichaApi(DEFAULT_API_CODE)
	const [userId, setUserId] = useState('demo-user')
	const [keyword, setKeyword] = useState('亿企查科技有限公司')
	const [paramsJson, setParamsJson] = useState(defaultParamsJson(api, keyword))
	const [state, setState] = useState<RequestState>({ loading: false, error: null, result: null })
	const canRun = settings?.hasAppkey !== false && settings?.hasSecretKey !== false
	const requiredParams = useMemo(() => (api ? parseParameters(api.requestJson) : []), [api])

	useEffect(() => {
		setParamsJson(defaultParamsJson(api, keyword))
		setState({ loading: false, error: null, result: null })
	}, [apiCode])

	const applyKeyword = () => {
		const current = parseJsonObject(paramsJson)
		current.keyword = keyword
		setParamsJson(JSON.stringify(current, null, 2))
	}

	const submit = async () => {
		if (!api) return
		setState({ loading: true, error: null, result: null })
		try {
			const response = await postJson(pluginRoute(app.pluginName, '/call'), {
				userId,
				api: api.apiCode,
				params: parseJsonObject(paramsJson),
			})
			const body = await readResponseBody(response)
			if (!response.ok) throw new Error(extractErrorMessage(body) ?? `请求失败：${response.status}`)
			setState({ loading: false, error: null, result: body })
		} catch (caught) {
			setState({
				loading: false,
				error: caught instanceof Error ? caught.message : String(caught),
				result: null,
			})
		}
	}

	return (
		<Card withBorder radius="md" p="lg">
			<Stack gap="md">
				<Group justify="space-between" align="center">
					<Group gap="xs">
						<IconSearch size={18} />
						<Title order={4}>接口测试</Title>
					</Group>
					{api ? (
						<Group gap="xs">
							<Badge variant="light">{api.requestMethod}</Badge>
							<Badge variant="light">{api.cateName}</Badge>
							<Badge variant="light">{api.apiCode}</Badge>
						</Group>
					) : null}
				</Group>
				{settings?.hasAppkey === false || settings?.hasSecretKey === false ? (
					<Alert color="yellow">先保存 YiQiCha App Key 和 Secret Key。</Alert>
				) : null}
				{state.error ? <Alert color="red">{state.error}</Alert> : null}
				<Select
					label="API"
					value={apiCode}
					onChange={(value) => {
						if (value) setApiCode(value)
					}}
					data={API_OPTIONS}
					searchable
					allowDeselect={false}
					leftSection={<IconSearch size={16} />}
					comboboxProps={{ withinPortal: false }}
				/>
				<Grid>
					<Grid.Col span={{ base: 12, sm: 5 }}>
						<TextInput
							label="userId"
							value={userId}
							onChange={(event) => setUserId(event.currentTarget.value)}
						/>
					</Grid.Col>
					<Grid.Col span={{ base: 12, sm: 5 }}>
						<TextInput
							label="keyword"
							value={keyword}
							onChange={(event) => setKeyword(event.currentTarget.value)}
						/>
					</Grid.Col>
					<Grid.Col span={{ base: 12, sm: 2 }}>
						<Button fullWidth variant="light" mt={25} onClick={applyKeyword}>
							填入
						</Button>
					</Grid.Col>
				</Grid>
				<RequiredParamsTable params={requiredParams} />
				<JsonInput
					label="请求参数 JSON"
					value={paramsJson}
					onChange={setParamsJson}
					autosize
					minRows={8}
					formatOnBlur
				/>
				{api ? (
					<Group gap="xs">
						<Badge variant="light">{api.apiUrl.replace('https://openapi.yiqicha.com', '')}</Badge>
						<Badge variant="light">
							required:{requiredParams.filter((item) => item.required).length}
						</Badge>
						{typeof api.unitPrice === 'number' ? (
							<Badge variant="light">price:{api.unitPrice}</Badge>
						) : null}
					</Group>
				) : null}
				<Group>
					<Button
						leftSection={<IconPlayerPlay size={16} />}
						loading={state.loading}
						disabled={!canRun || !api}
						onClick={() => void submit()}
					>
						调用接口
					</Button>
					<CopyButton value={jsonPretty(state.result)}>
						{({ copied, copy }) => (
							<Button variant="light" disabled={!state.result} onClick={copy}>
								{copied ? '已复制' : '复制结果'}
							</Button>
						)}
					</CopyButton>
				</Group>
				<Box
					style={{
						border: '1px solid var(--mantine-color-default-border)',
						borderRadius: 8,
						overflow: 'hidden',
					}}
				>
					<ScrollArea h={360} type="auto" scrollbarSize={10} offsetScrollbars>
						<Code block>{state.result ? jsonPretty(state.result) : '暂无结果'}</Code>
					</ScrollArea>
				</Box>
			</Stack>
		</Card>
	)
}

function RequiredParamsTable({ params }: { params: ReturnType<typeof parseParameters> }) {
	if (params.length === 0) return null
	return (
		<ScrollArea type="auto">
			<Table withTableBorder withColumnBorders highlightOnHover>
				<Table.Thead>
					<Table.Tr>
						<Table.Th>参数</Table.Th>
						<Table.Th>类型</Table.Th>
						<Table.Th>必填</Table.Th>
						<Table.Th>说明</Table.Th>
					</Table.Tr>
				</Table.Thead>
				<Table.Tbody>
					{params.map((param) => (
						<Table.Tr key={param.name}>
							<Table.Td>
								<Code>{param.name}</Code>
							</Table.Td>
							<Table.Td>{param.type ?? '-'}</Table.Td>
							<Table.Td>
								<Badge color={param.required ? 'red' : 'gray'} variant="light">
									{param.required ? '是' : '否'}
								</Badge>
							</Table.Td>
							<Table.Td>{param.desc ?? '-'}</Table.Td>
						</Table.Tr>
					))}
				</Table.Tbody>
			</Table>
		</ScrollArea>
	)
}

export function YiqichaHistoryPanel() {
	const app = useYiqichaApp()
	const rows = app.db.useList('history', { limit: 30, sort: { at: -1 } })
	const [error, setError] = useState<string | null>(null)

	const clear = async () => {
		try {
			await app.rpc.clearHistory()
			setError(null)
		} catch (caught) {
			setError(rpcErrorMessage(caught, '清空历史失败'))
		}
	}

	return (
		<Card withBorder radius="md" p="lg">
			<Stack gap="md">
				<Group justify="space-between">
					<Title order={4}>最近测试历史</Title>
					<Button
						variant="light"
						color="red"
						leftSection={<IconTrash size={16} />}
						onClick={() => void clear()}
					>
						清空历史
					</Button>
				</Group>
				{error ? <Alert color="red">{error}</Alert> : null}
				<ScrollArea h={360} type="auto">
					<Table striped highlightOnHover>
						<Table.Thead>
							<Table.Tr>
								<Table.Th>时间</Table.Th>
								<Table.Th>来源</Table.Th>
								<Table.Th>User</Table.Th>
								<Table.Th>接口</Table.Th>
								<Table.Th>状态</Table.Th>
								<Table.Th>请求摘要</Table.Th>
								<Table.Th>响应摘要</Table.Th>
							</Table.Tr>
						</Table.Thead>
						<Table.Tbody>
							{rows.map((row) => (
								<Table.Tr key={row.id}>
									<Table.Td>{new Date(row.at).toLocaleTimeString()}</Table.Td>
									<Table.Td>{row.source}</Table.Td>
									<Table.Td>{row.userId}</Table.Td>
									<Table.Td>
										<Stack gap={2}>
											<Text size="sm">{row.apiName ?? row.operation}</Text>
											<Text size="xs" c="dimmed">
												{row.apiCode ?? '-'}
											</Text>
										</Stack>
									</Table.Td>
									<Table.Td>
										<Badge color={row.ok ? 'teal' : 'red'} variant="light">
											{row.status}
										</Badge>
									</Table.Td>
									<Table.Td>
										<Code>{truncateText(row.requestPreview, 100)}</Code>
									</Table.Td>
									<Table.Td>
										<Code>{truncateText(row.responsePreview ?? row.error)}</Code>
									</Table.Td>
								</Table.Tr>
							))}
						</Table.Tbody>
					</Table>
				</ScrollArea>
			</Stack>
		</Card>
	)
}

function defaultParamsJson(api: YiqichaApi | undefined, keyword: string): string {
	const params: Record<string, unknown> = {}
	for (const param of api ? parseParameters(api.requestJson) : []) {
		if (!param.required) continue
		params[param.name] = defaultParamValue(param.name, param.type, keyword)
	}
	if (!('keyword' in params) && api?.requestJson.includes('"keyword"')) params.keyword = keyword
	if (api?.apiCode === DEFAULT_API_CODE) params.pageSize = 10
	return JSON.stringify(params, null, 2)
}

function defaultParamValue(name: string, type: string | undefined, keyword: string): unknown {
	if (name === 'keyword') return keyword
	const normalized = type?.toLowerCase()
	if (normalized?.includes('int') || normalized?.includes('number')) return 1
	if (normalized?.includes('bool')) return false
	return ''
}

function postJson(endpoint: string, payload: unknown): Promise<Response> {
	return fetch(endpoint, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(payload),
	})
}

async function readResponseBody(response: Response): Promise<unknown> {
	const contentType = response.headers.get('content-type') ?? ''
	if (contentType.includes('application/json')) return response.json()
	return response.text()
}

function extractErrorMessage(input: unknown): string | undefined {
	if (!input || typeof input !== 'object') return undefined
	const record = input as Record<string, unknown>
	if (typeof record.error === 'string') return record.error
	if (typeof record.message === 'string') return record.message
	if (typeof record.msg === 'string') return record.msg
	return undefined
}
