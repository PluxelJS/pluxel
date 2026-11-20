import {
	Alert,
	Button,
	Code,
	Group,
	NumberInput,
	Paper,
	Select,
	Stack,
	Text,
	Textarea,
	TextInput,
} from '@mantine/core'
import { OutboundHttpRevisionConflictError } from '@pluxel/services/management/client'
import type {
	OutboundHttpSettings,
	OutboundHttpSnapshot,
} from '@pluxel/services/management/protocol'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { runtimeErrorMessage, useRuntimeManagementClient } from '../../runtime'
import { managementQueryKeys, refetchManagementQuery } from '../managementQuery'
import { useOptionalWorkbenchDocument } from '../workbench/document'
import { useOptionalWorkspaceSession } from '../workbench/workspaceContext'
import {
	outboundHttpFormValues,
	readOutboundHttpForm,
	type OutboundHttpFormValues,
} from './settingsForm'

type Draft = Readonly<{ revision: number; changes: Partial<OutboundHttpFormValues> }>
type SaveInput = Readonly<{ revision: number; settings: OutboundHttpSettings | null }>
type Feedback = Readonly<{ color: 'red' | 'yellow' | 'green'; title: string; message?: string }>

const wrapText = { overflowWrap: 'anywhere' } as const
const appliedFieldStyles = {
	root: {
		display: 'flex',
		flexWrap: 'wrap',
		alignItems: 'baseline',
		columnGap: 'var(--mantine-spacing-xs)',
	},
	description: { flex: '1 1 16rem', minWidth: 0, ...wrapText },
	wrapper: { flexBasis: '100%', minWidth: 0 },
	error: { flexBasis: '100%' },
} as const

function describeOrigins(origins: readonly string[] | undefined) {
	if (origins === undefined) return '允许所有 HTTP(S) origin'
	return origins.length > 0 ? origins.join('、') : '禁止受管出站'
}

function describeTimeout(value: number) {
	return value === 0 ? '不限' : `${value.toLocaleString()} ms`
}

function AppliedValue({ children, source }: { children: ReactNode; source?: string }) {
	return (
		<>
			当前生效 ·{' '}
			<Text component="span" inherit c="var(--mantine-color-text)">
				{children}
			</Text>
			{source && ` · ${source}`}
		</>
	)
}

export function OutboundHttpEditor({ snapshot }: { snapshot: OutboundHttpSnapshot }) {
	const management = useRuntimeManagementClient()
	const queryClient = useQueryClient()
	const document = useOptionalWorkbenchDocument()
	const workspace = useOptionalWorkspaceSession()
	const { owner, settings: savedSettings, effective, limits } = snapshot
	const queryKey = managementQueryKeys.outboundHttpScope(owner)
	const queryFamily = managementQueryKeys.outboundHttp()
	const [draft, setDraftState] = useState<Draft>()
	const draftRef = useRef<Draft>(undefined)
	const [feedback, setFeedback] = useState<Feedback>()
	const pending = useRef(false)
	const revision = useRef(0)

	const setDraft = (value: Draft | undefined) => {
		draftRef.current = value
		revision.current++
		setDraftState(value)
	}
	const baseline = outboundHttpFormValues(savedSettings)
	const form = { ...baseline, ...draft?.changes }
	const edit = <K extends keyof OutboundHttpFormValues>(
		key: K,
		value: OutboundHttpFormValues[K],
	) => {
		const current = draftRef.current
		const changes = { ...current?.changes, [key]: value }
		if (JSON.stringify(value) === JSON.stringify(baseline[key])) delete changes[key]
		setDraft(
			Object.keys(changes).length > 0
				? { revision: current?.revision ?? snapshot.revision, changes }
				: undefined,
		)
		setFeedback(undefined)
	}

	const mutation = useMutation({
		scope: { id: 'management:outbound-http' },
		mutationFn: async ({ revision: expected, settings }: SaveInput) => {
			await queryClient.cancelQueries({ queryKey: queryFamily })
			return management.outboundHttp.save(owner, expected, settings)
		},
		onSuccess: async ({ snapshot: applied, cleanupError }) => {
			await queryClient.cancelQueries({ queryKey: queryFamily })
			queryClient.setQueryData<OutboundHttpSnapshot>(queryKey, (current) =>
				current && current.revision > applied.revision ? current : applied,
			)
			setDraft(undefined)
			setFeedback(
				cleanupError
					? { color: 'yellow', title: '设置已应用，旧代理清理失败', message: cleanupError }
					: { color: 'green', title: '设置已应用' },
			)
			await queryClient.invalidateQueries({ queryKey: queryFamily })
		},
		onError: async (error) => {
			await refetchManagementQuery(queryClient, queryKey)
			const refreshed = queryClient.getQueryState<OutboundHttpSnapshot>(queryKey)
			const current = draftRef.current
			if (error instanceof OutboundHttpRevisionConflictError) {
				if (current && refreshed?.status === 'success' && refreshed.data) {
					setDraft({ ...current, revision: refreshed.data.revision })
				}
				setFeedback({
					color: 'yellow',
					title: '出站设置版本已变化',
					message: '请核对当前生效值和草稿，再次保存会应用保留的字段更改。',
				})
			} else {
				setFeedback({
					color: 'red',
					title: '保存出站设置失败',
					message: runtimeErrorMessage(error),
				})
			}
		},
	})

	const save = async (reset = false) => {
		const current = draftRef.current
		if (pending.current || (!reset && !current)) return
		const latest = queryClient.getQueryData<OutboundHttpSnapshot>(queryKey) ?? snapshot
		let settings: OutboundHttpSettings | null
		try {
			settings = reset
				? null
				: readOutboundHttpForm({ ...outboundHttpFormValues(latest.settings), ...current?.changes })
		} catch (error) {
			setFeedback({ color: 'red', title: '检查出站设置', message: runtimeErrorMessage(error) })
			return
		}
		pending.current = true
		revision.current++
		setFeedback(undefined)
		try {
			await mutation.mutateAsync({ revision: current?.revision ?? snapshot.revision, settings })
		} catch {
			// The mutation reads back the authoritative snapshot and keeps the draft.
		} finally {
			pending.current = false
			revision.current++
		}
	}
	const saveRef = useRef(save)
	saveRef.current = save
	const editor = useMemo(
		() => ({
			isWritePending: () => pending.current,
			getState: () => ({
				hasUnsavedChanges: draftRef.current !== undefined,
				token: revision.current,
			}),
			save: () => saveRef.current(),
		}),
		[],
	)
	useEffect(() => {
		if (!document) return
		document.state.editor = editor
		workspace?.notifyContentState()
		return () => {
			if (document.state.editor === editor) document.state.editor = undefined
			workspace?.notifyContentState()
		}
	}, [document, editor, workspace])
	useEffect(() => {
		workspace?.notifyContentState()
	}, [draft, mutation.isPending, workspace])

	const submit = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault()
		void save()
	}
	const saving = mutation.isPending
	const inherits = owner ? '继承宿主' : '继承部署配置'
	const savedScope = owner ? '节点覆盖' : '宿主设置'
	const headers = Object.entries(effective.headers)
	return (
		<Paper withBorder p="md" component="form" aria-label="出站设置" onSubmit={submit}>
			<Stack gap="md">
				<Select
					label="目标策略"
					styles={appliedFieldStyles}
					description={
						<AppliedValue
							source={savedSettings.allowedOrigins === undefined ? inherits : '与上层取交集'}
						>
							{describeOrigins(effective.allowedOrigins)}
						</AppliedValue>
					}
					data={[
						{ value: 'inherit', label: inherits },
						{ value: 'deny', label: '禁止受管出站' },
						{ value: 'list', label: '仅允许指定 origin' },
					]}
					value={form.origins.mode}
					allowDeselect={false}
					disabled={saving}
					onChange={(mode) => {
						if (mode === 'inherit' || mode === 'deny' || mode === 'list')
							edit('origins', { ...form.origins, mode })
					}}
				/>
				{form.origins.mode === 'list' && (
					<Textarea
						label="允许的 origin"
						description="每行一个 HTTP(S) origin。上层限制仍然生效。启用允许列表后，受管请求需要显式处理重定向。"
						placeholder="https://api.example.com"
						rows={3}
						resize="vertical"
						value={form.origins.text}
						disabled={saving}
						onChange={(event) =>
							edit('origins', { ...form.origins, text: event.currentTarget.value })
						}
					/>
				)}
				<NumberInput
					label="单次尝试超时（毫秒）"
					styles={appliedFieldStyles}
					description={
						<AppliedValue
							source={savedSettings.timeoutMs === undefined ? inherits : '采用各层上限的最小值'}
						>
							{describeTimeout(effective.timeoutMs)}
						</AppliedValue>
					}
					placeholder={inherits}
					allowDecimal={false}
					min={1}
					clampBehavior="none"
					hideControls
					value={form.timeoutMs}
					disabled={saving}
					onChange={(value) => edit('timeoutMs', value)}
				/>
				<Select
					label="代理"
					styles={appliedFieldStyles}
					description={
						<AppliedValue
							source={
								limits.allowProxyChanges
									? savedSettings.proxyUrl === undefined
										? inherits
										: savedScope
									: '由宿主锁定'
							}
						>
							{effective.proxyUrl ?? '无受管代理'}
						</AppliedValue>
					}
					data={[
						{ value: 'inherit', label: inherits },
						{ value: 'direct', label: '无受管代理' },
						{ value: 'url', label: '指定代理地址' },
					]}
					value={form.proxy.mode}
					allowDeselect={false}
					disabled={saving || !limits.allowProxyChanges}
					onChange={(mode) => {
						if (mode === 'inherit' || mode === 'direct' || mode === 'url')
							edit('proxy', { ...form.proxy, mode })
					}}
				/>
				{form.proxy.mode === 'url' && (
					<TextInput
						label="代理地址"
						description="填写无凭据的 HTTP(S) origin。"
						placeholder="http://proxy.example.com:8080"
						value={form.proxy.url}
						disabled={saving || !limits.allowProxyChanges}
						onChange={(event) => edit('proxy', { ...form.proxy, url: event.currentTarget.value })}
					/>
				)}
				<Textarea
					label="默认请求头"
					description={
						<>
							<AppliedValue>
								{headers.length === 0
									? '无'
									: headers.map(([name, value]) => (
											<span key={name} style={{ display: 'block' }}>
												<Code>{name}</Code> {value}{' '}
												<Text component="span" inherit c="dimmed">
													·{' '}
													{Object.hasOwn(savedSettings.headers ?? {}, name) ? savedScope : inherits}
												</Text>
											</span>
										))}
							</AppliedValue>
							<span style={{ display: 'block' }}>
								每行填写一个名称和值。插件显式设置的同名头优先。
							</span>
						</>
					}
					styles={{ description: wrapText }}
					placeholder="Accept-Language: zh-CN"
					rows={3}
					resize="vertical"
					value={form.headers}
					disabled={saving}
					onChange={(event) => edit('headers', event.currentTarget.value)}
				/>
				<Text size="xs" c="dimmed" style={wrapText}>
					部署上限 ·{' '}
					{limits.allowedOrigins === undefined
						? ''
						: `${describeOrigins(limits.allowedOrigins)} · `}
					超时 {describeTimeout(limits.timeoutMs)} · 并发 {limits.maxConcurrentRequests} · 排队{' '}
					{limits.maxQueuedRequests}
				</Text>
				{feedback && (
					<Alert
						color={feedback.color}
						title={feedback.title}
						role={feedback.color === 'green' ? 'status' : 'alert'}
					>
						{feedback.message}
					</Alert>
				)}
				<Group justify="space-between" gap="xs" wrap="wrap">
					<Button
						type="button"
						variant="default"
						size="compact-sm"
						disabled={saving || Object.keys(savedSettings).length === 0}
						onClick={() => void save(true)}
					>
						恢复继承
					</Button>
					<Group gap="xs" wrap="wrap">
						{draft && (
							<Button
								type="button"
								variant="subtle"
								size="compact-sm"
								disabled={saving}
								onClick={() => {
									setDraft(undefined)
									setFeedback(undefined)
								}}
							>
								放弃草稿
							</Button>
						)}
						<Button type="submit" size="compact-sm" disabled={!draft} loading={saving}>
							保存并应用
						</Button>
					</Group>
				</Group>
			</Stack>
		</Paper>
	)
}
