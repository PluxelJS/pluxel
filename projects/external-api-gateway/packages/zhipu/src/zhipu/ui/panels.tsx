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
	Select,
	Stack,
	Table,
	Text,
	TextInput,
	Textarea,
	Title,
} from '@mantine/core'
import { rpcErrorMessage } from '@pluxel/runtime/web'
import { useWorkbenchHost } from '@pluxel/runtime/workbench/ui'
import { IconCheck, IconCloudUpload, IconKey, IconPlayerPlay, IconTrash } from '@tabler/icons-react'
import { useEffect, useRef, useState } from 'react'
import {
	DEFAULT_ZHIPU_BASE_URL,
	DEFAULT_ZHIPU_CHAT_MODEL,
	DEFAULT_ZHIPU_LAYOUT_MODEL,
	DEFAULT_ZHIPU_TOKENIZER_MODEL,
} from '@repo/external-api-gateway-shared/constants'
import type { ZhipuSettingsDoc, ZhipuStatusDoc, ZhipuTestRunDoc } from '../contracts'
import { useZhipuHistoryModel, useZhipuProviderModel } from './runtime'

type Mode = 'files-ocr' | 'layout-parsing'
type ApiMode =
	| 'chat'
	| 'tokenizer'
	| 'web-search'
	| 'reader'
	| 'file-parser-create'
	| 'file-parser-result'
	| 'file-parser-sync'
	| 'embeddings'
	| 'rerank'
	| 'moderations'
	| 'raw'

type ApiCatalogItem = {
	value: Exclude<ApiMode, 'raw'>
	label: string
	operation: string
	path: string
	method: 'GET' | 'POST'
	defaultModel?: string
	defaultBody: Record<string, unknown>
	transport?: 'json' | 'file-parser-upload' | 'file-parser-result'
}

type RequestState = {
	loading: boolean
	error: string | null
	result: unknown
}

function useZhipuApp() {
	return { model: useZhipuProviderModel(), ...useWorkbenchHost() }
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

const API_CATALOG: ApiCatalogItem[] = [
	{
		value: 'chat',
		label: 'Chat Completions',
		operation: 'chat.completions',
		path: '/chat/completions',
		method: 'POST',
		defaultModel: DEFAULT_ZHIPU_CHAT_MODEL,
		defaultBody: {
			model: DEFAULT_ZHIPU_CHAT_MODEL,
			messages: [{ role: 'user', content: '用一句话介绍 GLM。' }],
		},
	},
	{
		value: 'tokenizer',
		label: 'Tokenizer',
		operation: 'tokenizer',
		path: '/tokenizer',
		method: 'POST',
		defaultModel: DEFAULT_ZHIPU_TOKENIZER_MODEL,
		defaultBody: {
			model: DEFAULT_ZHIPU_TOKENIZER_MODEL,
			messages: [{ role: 'user', content: '估算这句话的 token 数。' }],
		},
	},
	{
		value: 'web-search',
		label: 'Web Search',
		operation: 'web_search',
		path: '/web_search',
		method: 'POST',
		defaultBody: {
			search_query: '智谱 GLM OpenAPI',
			search_engine: 'search-prime',
			search_intent: false,
			count: 5,
		},
	},
	{
		value: 'reader',
		label: 'Web Reader',
		operation: 'reader',
		path: '/reader',
		method: 'POST',
		defaultBody: {
			url: 'https://docs.z.ai/',
			return_format: 'markdown',
		},
	},
	{
		value: 'file-parser-create',
		label: 'File Parser Async',
		operation: 'file_parser.create',
		path: '/files/parser/create',
		method: 'POST',
		transport: 'file-parser-upload',
		defaultBody: {
			file_type: 'PDF',
			tool_type: 'prime',
		},
	},
	{
		value: 'file-parser-result',
		label: 'File Parser Result',
		operation: 'file_parser.result',
		path: '/files/parser/result/{task_id}/{format_type}',
		method: 'GET',
		transport: 'file-parser-result',
		defaultBody: {
			task_id: 'your_task_id',
			format_type: 'text',
		},
	},
	{
		value: 'file-parser-sync',
		label: 'File Parser Sync',
		operation: 'file_parser.sync',
		path: '/files/parser/sync',
		method: 'POST',
		transport: 'file-parser-upload',
		defaultBody: {
			file_type: 'PDF',
			tool_type: 'prime-sync',
		},
	},
	{
		value: 'embeddings',
		label: 'Embeddings',
		operation: 'embeddings.create',
		path: '/embeddings',
		method: 'POST',
		defaultBody: {
			model: 'embedding-3',
			input: 'hello world',
		},
	},
	{
		value: 'rerank',
		label: 'Rerank',
		operation: 'rerank.create',
		path: '/rerank',
		method: 'POST',
		defaultBody: {
			model: 'rerank',
			query: '什么是 GLM？',
			documents: ['GLM 是智谱的模型系列。', '天气很好。'],
			top_n: 2,
			return_documents: true,
		},
	},
	{
		value: 'moderations',
		label: 'Moderations',
		operation: 'moderations.create',
		path: '/moderations',
		method: 'POST',
		defaultBody: {
			model: 'moderation',
			input: 'hello',
		},
	},
]

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
				<Badge variant="light">Depends on usage recorder</Badge>
			</Group>
			<Grid>
				<Grid.Col span={{ base: 12, md: 7 }}>
					<ZhipuOcrPanel />
				</Grid.Col>
				<Grid.Col span={{ base: 12, md: 5 }}>
					<ZhipuSettingsPanel compact />
				</Grid.Col>
			</Grid>
			<ZhipuApiPanel />
			<ZhipuHistoryPanel />
		</Stack>
	)
}

export function ZhipuSettingsPanel({ compact = false }: { compact?: boolean }) {
	const app = useZhipuApp()
	const settings = app.model.settings.useOneById('settings')
	const status = app.model.status.useOneById('status')
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
			() => app.model.commands.saveSettings({ apiKey: apiKey.trim() || undefined, baseUrl }),
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
		const result = await run(() => app.model.commands.testConnection(testUserId), '测试调用失败')
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
						onClick={() => void run(() => app.model.commands.clearApiKey(), '清除 API Key 失败')}
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
	const settings = app.model.settings.useOneById('settings')
	const [mode, setMode] = useState<Mode>('layout-parsing')
	const [userId, setUserId] = useState('demo-user')
	const [file, setFile] = useState<File | null>(null)
	const [layoutFile, setLayoutFile] = useState<File | null>(null)
	const [fileRef, setFileRef] = useState('')
	const [prompt, setPrompt] = useState('')
	const [postprocessModel, setPostprocessModel] = useState(DEFAULT_ZHIPU_CHAT_MODEL)
	const [layoutJson, setLayoutJson] = useState(`{\n  "model": "${DEFAULT_ZHIPU_LAYOUT_MODEL}"\n}`)
	const [state, setState] = useState<RequestState>({ loading: false, error: null, result: null })
	const layoutHasFile = Boolean(layoutFile || fileRef.trim() || jsonStringField(layoutJson, 'file'))
	const canRun =
		(settings?.hasApiKey ?? true) && (mode === 'files-ocr' ? Boolean(file) : layoutHasFile)

	const submit = async () => {
		setState({ loading: true, error: null, result: null })
		try {
			const endpoint =
				mode === 'files-ocr'
					? pluginRoute(app.targetPluginId, '/files-ocr')
					: pluginRoute(app.targetPluginId, '/layout-parsing')
			const response =
				mode === 'files-ocr'
					? await submitFilesOcr(endpoint, userId, file)
					: await submitLayoutParsing(endpoint, userId, layoutFile, fileRef, layoutJson)
			const body = await readResponseBody(response)
			if (!response.ok) throw new Error(extractErrorMessage(body) ?? `请求失败：${response.status}`)
			if (prompt.trim()) {
				const chatResponse = await submitOcrPostprocess(
					pluginRoute(app.targetPluginId, '/chat-completions'),
					userId,
					postprocessModel,
					prompt,
					body,
				)
				const postprocess = await readResponseBody(chatResponse)
				if (!chatResponse.ok) {
					throw new Error(extractErrorMessage(postprocess) ?? `后处理失败：${chatResponse.status}`)
				}
				setState({ loading: false, error: null, result: { ocr: body, postprocess } })
				return
			}
			setState({ loading: false, error: null, result: { ocr: body } })
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
						rawJson={layoutJson}
						onFileChange={setLayoutFile}
						onFileRefChange={setFileRef}
						onRawJsonChange={setLayoutJson}
					/>
				)}
				<OcrPostprocessForm
					prompt={prompt}
					model={postprocessModel}
					onPromptChange={setPrompt}
					onModelChange={setPostprocessModel}
				/>
				<OcrRequestSummary
					mode={mode}
					userId={userId}
					filesOcrFile={file}
					layoutFile={layoutFile}
					fileRef={fileRef}
					prompt={prompt}
					postprocessModel={postprocessModel}
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
	rawJson,
	onFileChange,
	onFileRefChange,
	onRawJsonChange,
}: {
	file: File | null
	fileRef: string
	rawJson: string
	onFileChange: (file: File | null) => void
	onFileRefChange: (value: string) => void
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

function OcrPostprocessForm({
	prompt,
	model,
	onPromptChange,
	onModelChange,
}: {
	prompt: string
	model: string
	onPromptChange: (value: string) => void
	onModelChange: (value: string) => void
}) {
	return (
		<Stack gap="sm">
			<Textarea
				label="后处理 Prompt"
				placeholder="例如：基于 OCR markdown 提取发票号码、日期、金额，返回 JSON"
				value={prompt}
				onChange={(event) => onPromptChange(event.currentTarget.value)}
				autosize
				minRows={3}
			/>
			<TextInput
				label="后处理模型"
				value={model}
				onChange={(event) => onModelChange(event.currentTarget.value)}
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
	postprocessModel,
	layoutJson,
}: {
	mode: Mode
	userId: string
	filesOcrFile: File | null
	layoutFile: File | null
	fileRef: string
	prompt: string
	postprocessModel: string
	layoutJson: string
}) {
	const endpoint = mode === 'files-ocr' ? '/files/ocr' : '/layout_parsing'
	const layoutFileField = fileRef.trim() || jsonStringField(layoutJson, 'file')
	const fileSource =
		mode === 'files-ocr'
			? (filesOcrFile?.name ?? '-')
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
					<Badge variant="light">chat:{postprocessModel || '-'}</Badge>
					<Badge variant="light">json:{extraKeys.length}</Badge>
				</>
			) : null}
		</Group>
	)
}

export function ZhipuApiPanel() {
	const app = useZhipuApp()
	const settings = app.model.settings.useOneById('settings')
	const [mode, setMode] = useState<ApiMode>('chat')
	const [userId, setUserId] = useState('demo-user')
	const [rawJson, setRawJson] = useState(defaultApiJson('chat'))
	const [rawMethod, setRawMethod] = useState('POST')
	const [rawPath, setRawPath] = useState('/chat/completions')
	const [rawOperation, setRawOperation] = useState('chat.completions')
	const [rawModel, setRawModel] = useState(DEFAULT_ZHIPU_CHAT_MODEL)
	const [apiFile, setApiFile] = useState<File | null>(null)
	const [state, setState] = useState<RequestState>({ loading: false, error: null, result: null })
	const selected = apiCatalogItem(mode)
	const canRun =
		(settings?.hasApiKey ?? true) &&
		(selected?.transport === 'file-parser-upload' ? Boolean(apiFile) : true)

	const switchMode = (value: string) => {
		const next = value as ApiMode
		setMode(next)
		setRawJson(defaultApiJson(next))
		const item = apiCatalogItem(next)
		if (item) {
			setRawMethod(item.method)
			setRawPath(item.path)
			setRawOperation(item.operation)
			setRawModel(item.defaultModel ?? '')
		}
		setApiFile(null)
		setState({ loading: false, error: null, result: null })
	}

	const submit = async () => {
		setState({ loading: true, error: null, result: null })
		try {
			const item = apiCatalogItem(mode)
			let response: Response
			if (item?.transport === 'file-parser-upload') {
				response = await submitFileParserUpload(
					pluginRoute(
						app.targetPluginId,
						mode === 'file-parser-sync' ? '/file-parser-sync' : '/file-parser-create',
					),
					userId,
					apiFile,
					parseJsonObject(rawJson),
				)
			} else if (item?.transport === 'file-parser-result') {
				response = await postJson(pluginRoute(app.targetPluginId, '/file-parser-result'), {
					userId,
					...parseJsonObject(rawJson),
				})
			} else if (mode === 'raw') {
				response = await postJson(pluginRoute(app.targetPluginId, '/openapi'), {
					userId,
					method: rawMethod,
					path: rawPath,
					operation: rawOperation,
					model: rawModel || undefined,
					body: parseOpenApiBody(rawJson),
				})
			} else {
				response = await submitCatalogJson(
					pluginRoute(app.targetPluginId, '/openapi'),
					userId,
					requireApiCatalogItem(mode),
					parseJsonObject(rawJson),
				)
			}
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
					<Title order={4}>模型 / 工具 API</Title>
					<Select
						w={{ base: '100%', sm: 300 }}
						value={mode}
						onChange={(value) => {
							if (value) switchMode(value)
						}}
						data={[
							...API_CATALOG.map((item) => ({ label: item.label, value: item.value })),
							{ label: 'Raw OpenAPI', value: 'raw' },
						]}
						allowDeselect={false}
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
				{selected?.transport === 'file-parser-upload' ? (
					<FileInput label="待解析文件" value={apiFile} onChange={setApiFile} clearable />
				) : null}
				{mode === 'raw' ? (
					<Grid>
						<Grid.Col span={{ base: 12, sm: 3 }}>
							<TextInput
								label="Method"
								value={rawMethod}
								onChange={(event) => setRawMethod(event.currentTarget.value.toUpperCase())}
							/>
						</Grid.Col>
						<Grid.Col span={{ base: 12, sm: 9 }}>
							<TextInput
								label="Path"
								value={rawPath}
								onChange={(event) => setRawPath(event.currentTarget.value)}
							/>
						</Grid.Col>
						<Grid.Col span={{ base: 12, sm: 6 }}>
							<TextInput
								label="Operation"
								value={rawOperation}
								onChange={(event) => setRawOperation(event.currentTarget.value)}
							/>
						</Grid.Col>
						<Grid.Col span={{ base: 12, sm: 6 }}>
							<TextInput
								label="Billing model"
								value={rawModel}
								onChange={(event) => setRawModel(event.currentTarget.value)}
							/>
						</Grid.Col>
					</Grid>
				) : null}
				<JsonInput
					label={apiBodyLabel(mode, selected)}
					value={rawJson}
					onChange={setRawJson}
					autosize
					minRows={10}
					formatOnBlur
				/>
				<Group gap="xs">
					<Badge variant="light">{selected?.method ?? rawMethod}</Badge>
					<Badge variant="light">{selected?.path ?? rawPath}</Badge>
					<Badge variant="light">{selected?.operation ?? rawOperation}</Badge>
				</Group>
				<Group>
					<Button
						leftSection={<IconPlayerPlay size={16} />}
						loading={state.loading}
						disabled={!canRun}
						onClick={() => void submit()}
					>
						调用 API
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

export function ZhipuHistoryPanel() {
	const model = useZhipuHistoryModel()
	const rows = model.history.useMany({ limit: 30, sort: { at: -1 } })
	const [error, setError] = useState<string | null>(null)

	const clear = async () => {
		try {
			await model.commands.clearHistory()
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

function apiOperationLabel(mode: ApiMode): string {
	return apiCatalogItem(mode)?.operation ?? 'raw.openapi'
}

function apiBodyLabel(mode: ApiMode, selected: ApiCatalogItem | undefined): string {
	if (mode === 'raw') return 'Body JSON'
	if (selected?.transport === 'file-parser-upload') return '解析参数 JSON'
	if (selected?.transport === 'file-parser-result') return '任务结果 JSON'
	return `${apiOperationLabel(mode)} 请求 JSON`
}

function defaultApiJson(mode: ApiMode): string {
	if (mode === 'raw') return JSON.stringify({ model: DEFAULT_ZHIPU_CHAT_MODEL }, null, 2)
	return JSON.stringify(requireApiCatalogItem(mode).defaultBody, null, 2)
}

function apiCatalogItem(mode: ApiMode): ApiCatalogItem | undefined {
	if (mode === 'raw') return undefined
	return API_CATALOG.find((item) => item.value === mode)
}

function requireApiCatalogItem(mode: ApiMode): ApiCatalogItem {
	const item = apiCatalogItem(mode)
	if (!item) throw new Error(`Unknown API mode: ${mode}`)
	return item
}

function parseOpenApiBody(input: string): unknown {
	const trimmed = input.trim()
	if (!trimmed) return undefined
	return JSON.parse(trimmed)
}

function submitCatalogJson(
	endpoint: string,
	userId: string,
	item: ApiCatalogItem,
	payload: Record<string, unknown>,
): Promise<Response> {
	return postJson(endpoint, {
		userId,
		method: item.method,
		path: item.path,
		operation: item.operation,
		model: stringPayloadField(payload, 'model') ?? item.defaultModel,
		body: payload,
	})
}

function stringPayloadField(payload: Record<string, unknown>, key: string): string | undefined {
	const value = payload[key]
	return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function postJson(endpoint: string, payload: unknown): Promise<Response> {
	return fetch(endpoint, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(payload),
	})
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

async function submitFileParserUpload(
	endpoint: string,
	userId: string,
	file: File | null,
	payload: Record<string, unknown>,
): Promise<Response> {
	if (!file) throw new Error('请选择文件')
	const fileType = stringPayloadField(payload, 'file_type')
	const toolType = stringPayloadField(payload, 'tool_type')
	if (!fileType) throw new Error('请填写 file_type')
	if (!toolType) throw new Error('请填写 tool_type')
	const form = new FormData()
	form.append('userId', userId)
	form.append('file', file, file.name)
	for (const [key, value] of Object.entries(payload)) {
		if (value === undefined || value === null) continue
		form.append(key, typeof value === 'string' ? value : JSON.stringify(value))
	}
	return fetch(endpoint, { method: 'POST', body: form })
}

async function submitLayoutParsing(
	endpoint: string,
	userId: string,
	file: File | null,
	fileRef: string,
	rawJson: string,
): Promise<Response> {
	const payload = parseJsonObject(rawJson)
	payload.userId = userId
	if (file) {
		payload.file = await fileToDataUrl(file)
	} else if (fileRef.trim()) {
		payload.file = fileRef.trim()
	}
	return fetch(endpoint, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(payload),
	})
}

function submitOcrPostprocess(
	endpoint: string,
	userId: string,
	model: string,
	prompt: string,
	ocrResult: unknown,
): Promise<Response> {
	return fetch(endpoint, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			userId,
			model: model.trim() || DEFAULT_ZHIPU_CHAT_MODEL,
			messages: [
				{
					role: 'system',
					content: '你负责把 OCR/文档解析结果按用户要求转换为稳定、精炼、可机读的结果。',
				},
				{
					role: 'user',
					content: ['用户要求：', prompt.trim(), '', 'OCR 结果 JSON：', jsonPretty(ocrResult)].join(
						'\n',
					),
				},
			],
			response_format: { type: 'json_object' },
		}),
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
