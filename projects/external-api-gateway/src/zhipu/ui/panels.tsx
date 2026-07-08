import {
	Alert,
	Badge,
	Box,
	Button,
	Card,
	Code,
	CopyButton,
	FileInput,
	Grid,
	Group,
	JsonInput,
	PasswordInput,
	ScrollArea,
	SegmentedControl,
	Stack,
	Table,
	Text,
	TextInput,
	Textarea,
	Title,
} from '@mantine/core'
import { rpcErrorMessage } from '@pluxel/runtime/web/ui'
import { IconCheck, IconCloudUpload, IconKey, IconPlayerPlay, IconTrash } from '@tabler/icons-react'
import { useEffect, useRef, useState } from 'react'
import { DEFAULT_ZHIPU_BASE_URL, DEFAULT_ZHIPU_LAYOUT_MODEL } from '../../constants'
import type { ZhipuSettingsDoc, ZhipuStatusDoc, ZhipuTestRunDoc } from '../contracts'
import { zhipuPlugin } from './runtime'

type Mode = 'files-ocr' | 'layout-parsing'

type ZhipuUiApp = {
	pluginName: 'ZhipuProviderPlugin'
	rpc: {
		saveSettings(input: { apiKey?: string; baseUrl?: string }): Promise<ZhipuSettingsDoc>
		clearApiKey(): Promise<ZhipuSettingsDoc>
		testConnection(userId?: string): Promise<{ ok: boolean; message: string }>
		clearHistory(): Promise<{ ok: true }>
	}
	db: {
		useDocById(collection: 'settings', id: 'settings'): ZhipuSettingsDoc | undefined
		useDocById(collection: 'status', id: 'status'): ZhipuStatusDoc | undefined
		useList(
			collection: 'history',
			spec?: { limit?: number; sort?: Partial<Record<keyof ZhipuTestRunDoc, 1 | -1>> },
		): ZhipuTestRunDoc[]
	}
}

type RequestState = {
	loading: boolean
	error: string | null
	result: unknown
}

function useZhipuApp(): ZhipuUiApp {
	return zhipuPlugin.use() as unknown as ZhipuUiApp
}

function pluginRoute(pluginName: string, path: string) {
	return `/__pluxel/plugins/${encodeURIComponent(pluginName)}/zhipu${path}`
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

function safeJsonObject(input: string): Record<string, unknown> {
	try {
		return parseJsonObject(input)
	} catch {
		return {}
	}
}

function jsonStringField(input: string, key: string): string | undefined {
	const value = safeJsonObject(input)[key]
	return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function truncateText(input: string | undefined, length = 120): string {
	if (!input) return '-'
	return input.length > length ? `${input.slice(0, length)}...` : input
}

function settingsBadge(settings: ZhipuSettingsDoc | undefined): string | null {
	if (!settings) return '加载中'
	return settings.hasApiKey ? settings.apiKeyPreview : '未配置'
}

export function ZhipuDashboard() {
	return (
		<Stack gap="lg" p="md">
			<Group justify="space-between" align="center">
				<Stack gap={2}>
					<Title order={3}>Zhipu Provider</Title>
					<Text size="sm" c="dimmed">
						智谱 OpenAPI provider，调用会自动写入 Usage Billing
					</Text>
				</Stack>
				<Badge variant="light">Depends on UsageBillingPlugin</Badge>
			</Group>
			<Grid>
				<Grid.Col span={{ base: 12, md: 7 }}>
					<ZhipuOcrPanel />
				</Grid.Col>
				<Grid.Col span={{ base: 12, md: 5 }}>
					<ZhipuSettingsPanel compact />
				</Grid.Col>
			</Grid>
			<ZhipuHistoryPanel />
		</Stack>
	)
}

export function ZhipuSettingsPanel({ compact = false }: { compact?: boolean }) {
	const app = useZhipuApp()
	const settings = app.db.useDocById('settings', 'settings')
	const status = app.db.useDocById('status', 'status')
	const [apiKey, setApiKey] = useState('')
	const [baseUrl, setBaseUrl] = useState(DEFAULT_ZHIPU_BASE_URL)
	const baseUrlEdited = useRef(false)
	const [testUserId, setTestUserId] = useState('system')
	const [error, setError] = useState<string | null>(null)
	const [message, setMessage] = useState<string | null>(null)

	useEffect(() => {
		if (baseUrlEdited.current) return
		setBaseUrl(settings?.baseUrl ?? DEFAULT_ZHIPU_BASE_URL)
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
			() => app.rpc.saveSettings({ apiKey: apiKey.trim() || undefined, baseUrl }),
			'保存设置失败',
		)
		if (result) {
			setApiKey('')
			baseUrlEdited.current = false
			setBaseUrl(result.baseUrl)
			setMessage('设置已保存')
		}
	}

	const test = async () => {
		const result = await run(() => app.rpc.testConnection(testUserId), '测试调用失败')
		if (result) setMessage(result.message)
	}

	return (
		<Card withBorder radius="md" p={compact ? 'md' : 'lg'}>
			<Stack gap="md">
				<Group justify="space-between">
					<Group gap="xs">
						<IconKey size={18} />
						<Title order={compact ? 5 : 4}>Zhipu 设置</Title>
					</Group>
					<Badge color={settings?.hasApiKey ? 'teal' : 'gray'} variant="light">
						{settingsBadge(settings)}
					</Badge>
				</Group>
				{error ? <Alert color="red">{error}</Alert> : null}
				{message ? (
					<Alert color={status?.lastOk === false ? 'yellow' : 'green'}>{message}</Alert>
				) : null}
				<PasswordInput
					label="API Key"
					placeholder="填入智谱 API Key"
					value={apiKey}
					onChange={(event) => setApiKey(event.currentTarget.value)}
				/>
				<TextInput
					label="Base URL"
					value={baseUrl}
					onChange={(event) => {
						baseUrlEdited.current = true
						setBaseUrl(event.currentTarget.value)
					}}
				/>
				<TextInput
					label="测试 userId"
					value={testUserId}
					onChange={(event) => setTestUserId(event.currentTarget.value)}
				/>
				<Group>
					<Button leftSection={<IconCheck size={16} />} onClick={() => void save()}>
						保存
					</Button>
					<Button
						variant="light"
						leftSection={<IconPlayerPlay size={16} />}
						onClick={() => void test()}
					>
						测试 Key
					</Button>
					<Button
						variant="subtle"
						color="red"
						leftSection={<IconTrash size={16} />}
						onClick={() => void run(() => app.rpc.clearApiKey(), '清除 API Key 失败')}
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

export function ZhipuOcrPanel() {
	const app = useZhipuApp()
	const settings = app.db.useDocById('settings', 'settings')
	const [mode, setMode] = useState<Mode>('layout-parsing')
	const [userId, setUserId] = useState('demo-user')
	const [file, setFile] = useState<File | null>(null)
	const [layoutFile, setLayoutFile] = useState<File | null>(null)
	const [fileRef, setFileRef] = useState('')
	const [prompt, setPrompt] = useState('')
	const [layoutJson, setLayoutJson] = useState(`{\n  "model": "${DEFAULT_ZHIPU_LAYOUT_MODEL}"\n}`)
	const [state, setState] = useState<RequestState>({ loading: false, error: null, result: null })
	const layoutHasFile = Boolean(layoutFile || fileRef.trim() || jsonStringField(layoutJson, 'file'))
	const canRun =
		(settings?.hasApiKey ?? true) &&
		(mode === 'files-ocr' ? Boolean(file) : layoutHasFile)

	const submit = async () => {
		setState({ loading: true, error: null, result: null })
		try {
			const endpoint =
				mode === 'files-ocr'
					? pluginRoute(app.pluginName, '/files-ocr')
					: pluginRoute(app.pluginName, '/layout-parsing')
			const response =
				mode === 'files-ocr'
					? await submitFilesOcr(endpoint, userId, file)
					: await submitLayoutParsing(endpoint, userId, layoutFile, fileRef, prompt, layoutJson)
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
				<Group justify="space-between">
					<Group gap="xs">
						<IconCloudUpload size={18} />
						<Title order={4}>OCR 调用</Title>
					</Group>
					<SegmentedControl
						value={mode}
						onChange={(value) => setMode(value as Mode)}
						data={[
							{ label: 'GLM OCR', value: 'layout-parsing' },
							{ label: 'Files OCR', value: 'files-ocr' },
						]}
					/>
				</Group>
				{settings?.hasApiKey === false ? (
					<Alert color="yellow">先保存 Zhipu API Key。</Alert>
				) : null}
				{state.error ? <Alert color="red">{state.error}</Alert> : null}
				<TextInput
					label="userId"
					value={userId}
					onChange={(event) => setUserId(event.currentTarget.value)}
				/>
				{mode === 'files-ocr' ? (
					<FilesOcrForm file={file} onFileChange={setFile} />
				) : (
					<LayoutParsingForm
						file={layoutFile}
						fileRef={fileRef}
						prompt={prompt}
						rawJson={layoutJson}
						onFileChange={setLayoutFile}
						onFileRefChange={setFileRef}
						onPromptChange={setPrompt}
						onRawJsonChange={setLayoutJson}
					/>
				)}
				<OcrRequestSummary
					mode={mode}
					userId={userId}
					filesOcrFile={file}
					layoutFile={layoutFile}
					fileRef={fileRef}
					prompt={prompt}
					layoutJson={layoutJson}
				/>
				<Group>
					<Button
						leftSection={<IconPlayerPlay size={16} />}
						loading={state.loading}
						disabled={!canRun}
						onClick={() => void submit()}
					>
						调用 OCR
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
					<ScrollArea h={320} type="auto" scrollbarSize={10} offsetScrollbars>
						<Code block>{state.result ? jsonPretty(state.result) : '暂无结果'}</Code>
					</ScrollArea>
				</Box>
			</Stack>
		</Card>
	)
}

function FilesOcrForm({
	file,
	onFileChange,
}: {
	file: File | null
	onFileChange: (file: File | null) => void
}) {
	return (
		<Stack gap="sm">
			<FileInput label="上传图片或 PDF" value={file} onChange={onFileChange} clearable />
			<Text size="sm" c="dimmed">
				以 multipart 表单转发到 <Code>/files/ocr</Code>，并记录 userId 账单。
			</Text>
		</Stack>
	)
}

function LayoutParsingForm({
	file,
	fileRef,
	prompt,
	rawJson,
	onFileChange,
	onFileRefChange,
	onPromptChange,
	onRawJsonChange,
}: {
	file: File | null
	fileRef: string
	prompt: string
	rawJson: string
	onFileChange: (file: File | null) => void
	onFileRefChange: (value: string) => void
	onPromptChange: (value: string) => void
	onRawJsonChange: (value: string) => void
}) {
	return (
		<Stack gap="sm">
			<FileInput label="上传图片或 PDF" value={file} onChange={onFileChange} clearable />
			<TextInput
				label="OpenAPI file 字段（URL 或 base64，可选）"
				placeholder="https://example.com/demo.pdf"
				value={fileRef}
				onChange={(event) => onFileRefChange(event.currentTarget.value)}
				disabled={Boolean(file)}
			/>
			<Textarea
				label="Prompt"
				placeholder="例如：请提取发票号码、日期、金额，返回 JSON"
				value={prompt}
				onChange={(event) => onPromptChange(event.currentTarget.value)}
				autosize
				minRows={3}
			/>
			<JsonInput
				label="额外 JSON 参数"
				value={rawJson}
				onChange={onRawJsonChange}
				autosize
				minRows={5}
				formatOnBlur
			/>
		</Stack>
	)
}

function OcrRequestSummary({
	mode,
	userId,
	filesOcrFile,
	layoutFile,
	fileRef,
	prompt,
	layoutJson,
}: {
	mode: Mode
	userId: string
	filesOcrFile: File | null
	layoutFile: File | null
	fileRef: string
	prompt: string
	layoutJson: string
}) {
	const endpoint = mode === 'files-ocr' ? '/files/ocr' : '/layout_parsing'
	const layoutFileField = fileRef.trim() || jsonStringField(layoutJson, 'file')
	const fileSource =
		mode === 'files-ocr'
			? filesOcrFile?.name ?? '-'
			: layoutFile?.name || truncateText(layoutFileField, 80)
	const extraKeys = Object.keys(safeJsonObject(layoutJson)).filter((key) => key !== 'file')
	return (
		<Group gap="xs">
			<Badge variant="light">{endpoint}</Badge>
			<Badge variant="light">user:{userId || '-'}</Badge>
			<Badge variant="light">file:{fileSource}</Badge>
			{mode === 'layout-parsing' ? (
				<>
					<Badge variant="light">prompt:{prompt.trim().length}</Badge>
					<Badge variant="light">json:{extraKeys.length}</Badge>
				</>
			) : null}
		</Group>
	)
}

export function ZhipuHistoryPanel() {
	const app = useZhipuApp()
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
								<Table.Th>操作</Table.Th>
								<Table.Th>状态</Table.Th>
								<Table.Th>文件</Table.Th>
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
											<Text size="sm">{row.operation}</Text>
											{row.model ? (
												<Text size="xs" c="dimmed">
													{row.model}
												</Text>
											) : null}
										</Stack>
									</Table.Td>
									<Table.Td>
										<Badge color={row.ok ? 'teal' : 'red'} variant="light">
											{row.status}
										</Badge>
									</Table.Td>
									<Table.Td>{row.fileName ?? '-'}</Table.Td>
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

async function submitFilesOcr(
	endpoint: string,
	userId: string,
	file: File | null,
): Promise<Response> {
	if (!file) throw new Error('请选择文件')
	const form = new FormData()
	form.append('userId', userId)
	form.append('file', file, file.name)
	form.append('tool_type', 'hand_write')
	return fetch(endpoint, { method: 'POST', body: form })
}

async function submitLayoutParsing(
	endpoint: string,
	userId: string,
	file: File | null,
	fileRef: string,
	prompt: string,
	rawJson: string,
): Promise<Response> {
	const payload = parseJsonObject(rawJson)
	payload.userId = userId
	if (file) {
		payload.file = await fileToDataUrl(file)
	} else if (fileRef.trim()) {
		payload.file = fileRef.trim()
	}
	if (prompt.trim()) payload.prompt = prompt.trim()
	return fetch(endpoint, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(payload),
	})
}

function fileToDataUrl(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader()
		reader.onerror = () => reject(reader.error ?? new Error('读取文件失败'))
		reader.onload = () => {
			if (typeof reader.result === 'string') {
				resolve(reader.result)
				return
			}
			reject(new Error('读取文件失败'))
		}
		reader.readAsDataURL(file)
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
	if (record.error && typeof record.error === 'object') {
		const error = record.error as Record<string, unknown>
		if (typeof error.message === 'string') return error.message
		if (typeof error.msg === 'string') return error.msg
	}
	if (typeof record.message === 'string') return record.message
	if (typeof record.msg === 'string') return record.msg
	return undefined
}
