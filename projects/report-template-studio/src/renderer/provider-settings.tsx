import { useEffect, useState } from 'react'
import {
	Alert,
	Button,
	Checkbox,
	Group,
	Modal,
	PasswordInput,
	Select,
	Stack,
	Text,
	TextInput,
} from '@mantine/core'
import type { AiProvider, AiProviderWrite } from '../shared/ai-providers'
import type { AiModel } from '../shared/contracts'
import { api } from './api'
import { modelImageInput } from '../shared/model-image-input'

export function ProviderSettings({
	opened,
	onClose,
	onChanged,
}: {
	opened: boolean
	onClose(): void
	onChanged(model: AiModel): void
}) {
	const [providers, setProviders] = useState<AiProvider[]>([])
	const [apis, setApis] = useState<string[]>([])
	const [id, setId] = useState<string | null>('company-proxy')
	const [baseUrl, setBaseUrl] = useState('')
	const [protocol, setProtocol] = useState<string | null>(null)
	const [model, setModel] = useState('')
	const [imageInput, setImageInput] = useState(false)
	const [imageInputChanged, setImageInputChanged] = useState(false)
	const [key, setKey] = useState('')
	const [models, setModels] = useState<AiModel[]>([])
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState('')
	const [notice, setNotice] = useState('')
	const current = providers.find((provider) => provider.id === id)
	function choose(provider?: AiProvider) {
		setId(provider?.id ?? null)
		setBaseUrl(provider?.baseUrl ?? '')
		setProtocol(provider?.api ?? null)
		setModel(provider?.model ?? provider?.suggestedModel ?? '')
		setImageInput(provider?.imageInput ?? false)
		setImageInputChanged(false)
		setModels(provider?.models ?? [])
		setKey('')
		setError('')
		setNotice('')
	}
	function chooseModel(next: string) {
		setModel(next)
		setImageInputChanged(false)
		const modelId = next.trim()
		setImageInput(
			modelId === current?.model
				? current.imageInput
				: (current?.models.find((item) => item.id === modelId)?.imageInput ??
						modelImageInput({ id: modelId })),
		)
	}
	useEffect(() => {
		if (!opened) {
			setKey('')
			return
		}
		let active = true
		void api<{ providers: AiProvider[]; apis: string[] }>('/api/ai/providers')
			.then((result) => {
				if (!active) return
				setProviders(result.providers)
				setApis(result.apis)
				choose(result.providers.find((provider) => provider.id === id) ?? result.providers[0])
				return undefined
			})
			.catch((cause) => {
				if (active) setError(String(cause))
			})
		return () => {
			active = false
		}
	}, [opened])
	async function save(discover = false, clearKey = false) {
		if (!id) return
		setBusy(true)
		setError('')
		setNotice('')
		try {
			const body: AiProviderWrite = {
				baseUrl,
				api: protocol ?? undefined,
				model,
				...(imageInputChanged ? { imageInput } : {}),
				...(clearKey ? { apiKey: null } : key ? { apiKey: key } : {}),
			}
			const saved = await api<AiProvider>(`/api/ai/providers/${encodeURIComponent(id)}`, {
				method: 'PUT',
				body,
			})
			setKey('')
			setImageInput(saved.imageInput)
			setImageInputChanged(false)
			setProviders((previous) =>
				previous.map((provider) => (provider.id === id ? saved : provider)),
			)
			onChanged({
				provider: saved.id,
				id: saved.model,
				name: saved.model,
				imageInput: saved.imageInput,
			})
			if (discover) {
				const found = await api<AiModel[]>(`/api/ai/providers/${encodeURIComponent(id)}/models`, {
					method: 'POST',
				})
				setModels(found)
				setNotice(`读取到 ${found.length} 个模型。请选择模型后保存；列表不代表端点支持所选协议。`)
			} else
				setNotice(clearKey ? '已移除 Studio 保存的密钥，不影响 Pi / 环境凭据。' : '配置已保存。')
		} catch (cause) {
			setError(String(cause))
		} finally {
			setBusy(false)
		}
	}
	return (
		<Modal opened={opened} onClose={busy ? () => {} : onClose} title="模型供应商" size="lg">
			<Stack>
				<Select
					label="供应商"
					searchable
					value={id}
					disabled={busy}
					data={providers.map((provider) => ({ value: provider.id, label: provider.name }))}
					onChange={(next) => choose(providers.find((provider) => provider.id === next))}
				/>
				<Text size="xs" c="dimmed">
					供应商与协议来自本机 Pi。凭据保存在应用配置中，不进入工作区或导出的 ZIP。
				</Text>
				<TextInput
					label="API 地址"
					placeholder="https://example.com/v1"
					value={baseUrl}
					disabled={busy}
					onChange={(event) => setBaseUrl(event.currentTarget.value)}
				/>
				<Select
					label="API 协议"
					searchable
					data={apis}
					value={protocol}
					disabled={busy}
					onChange={setProtocol}
				/>
				<PasswordInput
					label="API Key"
					autoComplete="new-password"
					value={key}
					disabled={busy}
					placeholder={current?.hasCredential ? '已配置；留空保留现有凭据' : '填写 API Key'}
					onChange={(event) => setKey(event.currentTarget.value)}
				/>
				{current?.authType && current.authType !== 'none' && (
					<Text size="xs" c="dimmed">
						当前凭据来源：{current.authType}。已有 Pi OAuth / 环境凭据仍由 Pi 处理。
					</Text>
				)}
				<Group>
					<Button variant="light" loading={busy} onClick={() => void save(true)}>
						保存并发现模型
					</Button>
					{current?.hasCredential && (
						<Button
							variant="subtle"
							color="red"
							disabled={busy}
							onClick={() => void save(false, true)}
						>
							移除 Studio 密钥
						</Button>
					)}
				</Group>
				{models.length > 0 && (
					<Select
						label="模型列表"
						searchable
						clearable
						value={models.some((item) => item.id === model) ? model : null}
						data={models.map((item) => ({ value: item.id, label: item.name }))}
						disabled={busy}
						onChange={(next) => {
							if (next) chooseModel(next)
						}}
					/>
				)}
				<TextInput
					label="模型 ID"
					description="支持手动填写；发现接口不可用时可直接指定。"
					value={model}
					disabled={busy}
					onChange={(event) => chooseModel(event.currentTarget.value)}
				/>
				<Checkbox
					label="该模型支持图片输入"
					description="根据 Pi 和内置 models.dev 信息选择；代理端点可能不同，可按实际能力调整。发现列表只提供模型 ID。"
					size="xs"
					checked={imageInput}
					disabled={busy}
					onChange={(event) => {
						setImageInput(event.currentTarget.checked)
						setImageInputChanged(true)
					}}
				/>
				{current?.suggestedModel && (
					<Text size="xs" c="dimmed">
						建议模型：{current.suggestedModel}，实际可用性由供应商决定。
					</Text>
				)}
				{error && <Alert color="red">{error}</Alert>}
				{notice && <Alert color="teal">{notice}</Alert>}
				<Group justify="flex-end">
					<Button disabled={!id} loading={busy} onClick={() => void save()}>
						保存配置
					</Button>
				</Group>
			</Stack>
		</Modal>
	)
}
