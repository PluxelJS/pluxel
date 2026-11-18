import { Alert, Button, Group, Modal, NumberInput, Stack, Text } from '@mantine/core'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import type { HostExecutionPolicyField, HostPolicyPatch } from '@pluxel/host'
import type { PolicyResult } from '@pluxel/services/management/client'
import { runtimeErrorMessage, useRuntimeManagementClient } from '../../runtime'
import { managementQueryKeys, refetchManagementQuery } from '../managementQuery'
import { refreshPluginReadModels } from '../plugins/pluginReadModels'

const fields = {
	startTimeoutMs: '默认启动期限（毫秒）',
	drainTimeoutMs: '排空期限（毫秒）',
	startConcurrency: '启动并发预算',
	stopConcurrency: '停止并发预算',
} satisfies Record<HostExecutionPolicyField, string>
const fieldNames = Object.keys(fields) as HostExecutionPolicyField[]
type Draft = {
	revision: string
	values: Partial<Record<HostExecutionPolicyField, string | number>>
}

export function HostExecutionPolicy() {
	const [opened, setOpened] = useState(false)
	return (
		<>
			<Button variant="default" onClick={() => setOpened(true)}>
				宿主执行参数
			</Button>
			<Modal opened={opened} onClose={() => setOpened(false)} title="宿主执行参数">
				{opened ? <ExecutionPolicyEditor /> : null}
			</Modal>
		</>
	)
}

function ExecutionPolicyEditor() {
	const management = useRuntimeManagementClient()
	const queryClient = useQueryClient()
	const queryKey = managementQueryKeys.hostPolicy()
	const query = useQuery({ queryKey, queryFn: () => management.policy.get() })
	const [draft, setDraft] = useState<Draft>()
	const refreshDraftBaseline = async () => {
		await refetchManagementQuery(queryClient, queryKey)
		const current = queryClient.getQueryData<PolicyResult>(queryKey)
		if (current?.ok) {
			setDraft((value) => value && { ...value, revision: current.managedRevision })
		}
	}
	const mutation = useMutation({
		mutationFn: (input: { patch: HostPolicyPatch; revision: string }) =>
			management.policy.patch(input.patch, { expectedManagedRevision: input.revision }),
		onMutate: () => queryClient.cancelQueries({ queryKey, exact: true }),
		onSuccess: async (result) => {
			if (result.ok) {
				await queryClient.cancelQueries({ queryKey, exact: true })
				queryClient.setQueryData(queryKey, result)
				setDraft(undefined)
			} else if (result.state === 'unknown' || result.code === 'revision_conflict') {
				await refreshDraftBaseline()
			}
			await refreshPluginReadModels(queryClient)
		},
		onError: async () => {
			await Promise.all([refreshDraftBaseline(), refreshPluginReadModels(queryClient)])
		},
	})
	const policy = query.data?.ok ? query.data : undefined
	const rejected = mutation.data?.ok === false ? mutation.data : undefined
	const warning = rejected?.state === 'unknown' || mutation.isError
	const error =
		rejected?.message ??
		(mutation.error || query.error
			? runtimeErrorMessage(mutation.error ?? query.error)
			: query.data?.ok === false
				? query.data.message
				: undefined)
	const title = warning
		? '执行策略保存结果待核对'
		: rejected?.code === 'revision_conflict'
			? '执行策略版本已变化'
			: '执行策略操作失败'
	return (
		<Stack gap="sm">
			{error ? (
				<Alert color={warning ? 'yellow' : 'red'} title={title}>
					{error}
				</Alert>
			) : null}
			{policy ? (
				<ExecutionPolicyForm
					policy={policy}
					values={draft?.values}
					pending={mutation.isPending}
					onChange={(field, value) =>
						setDraft((previous) => ({
							revision: previous?.revision ?? policy.managedRevision,
							values: { ...previous?.values, [field]: value },
						}))
					}
					save={(patch) =>
						mutation.mutate({ patch, revision: draft?.revision ?? policy.managedRevision })
					}
				/>
			) : query.isPending ? (
				<Text size="sm">正在读取执行策略…</Text>
			) : (
				<Button variant="default" onClick={() => void query.refetch()}>
					重新读取
				</Button>
			)}
		</Stack>
	)
}

function ExecutionPolicyForm({
	policy,
	values,
	pending,
	onChange,
	save,
}: {
	policy: Extract<PolicyResult, { ok: true }>
	values: Draft['values'] | undefined
	pending: boolean
	onChange(field: HostExecutionPolicyField, value: string | number): void
	save(patch: HostPolicyPatch): void
}) {
	const changed = fieldNames.filter(
		(field) =>
			values?.[field] !== undefined && values[field] !== (policy.managedInput[field] ?? ''),
	)
	const valid = changed.every((field) => {
		const value = values?.[field]
		return (
			value === '' ||
			(typeof value === 'number' &&
				Number.isSafeInteger(value) &&
				value >= 1 &&
				(!field.endsWith('TimeoutMs') || value <= 2_147_483_647))
		)
	})
	const canSave = !policy.readonly && !pending && valid && changed.length > 0
	const submit = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault()
		if (!canSave) return
		const set: Partial<Record<HostExecutionPolicyField, number>> = {}
		const reset: HostExecutionPolicyField[] = []
		for (const field of changed) {
			const value = values?.[field]
			if (typeof value === 'number') set[field] = value
			else reset.push(field)
		}
		save({ ...set, reset })
	}
	return (
		<form onSubmit={submit}>
			<Stack gap="sm">
				<Text size="sm" c="dimmed">
					留空恢复继承。采用新的执行参数需要重建宿主。
				</Text>
				{policy.readonly ? <Text size="sm">此宿主的策略文档为只读。</Text> : null}
				{fieldNames.map((field) => {
					const source = { declared: '宿主声明', saved: '保存输入', default: 'Core 默认' }[
						policy.sources[field]
					]
					const adopted = policy.pendingExecutionFields.includes(field)
						? `当前采用 ${policy.appliedExecution[field]}，重建后采用 ${policy.effective[field]}`
						: `当前采用 ${policy.appliedExecution[field]}`
					const shadowed = policy.shadowedFields.includes(field) ? ' · 保存值被覆盖' : ''
					return (
						<NumberInput
							key={field}
							label={fields[field]}
							description={`${adopted} · ${policy.mode[field]} · ${source}${shadowed}`}
							value={values?.[field] ?? policy.managedInput[field] ?? ''}
							placeholder="继承"
							min={1}
							max={field.endsWith('TimeoutMs') ? 2_147_483_647 : Number.MAX_SAFE_INTEGER}
							allowDecimal={false}
							clampBehavior="none"
							hideControls
							disabled={policy.readonly || pending}
							onChange={(value) => onChange(field, value)}
						/>
					)
				})}
				<Group justify="flex-end">
					<Button type="submit" disabled={!canSave} loading={pending}>
						保存
					</Button>
				</Group>
			</Stack>
		</form>
	)
}
