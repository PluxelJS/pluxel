import {
	Alert,
	Button,
	Card,
	Group,
	MantineProvider,
	NumberInput,
	Stack,
	Table,
	Text,
	TextInput,
	Title,
} from '@mantine/core'
import { IconDeviceFloppy, IconPlus, IconRestore, IconTrash } from '@tabler/icons-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { WretchManagedSettingsSnapshot } from '../workbench-contracts.ts'
import {
	resetWretchSettingsMutation,
	settingsScope,
	updateWretchSettingsMutation,
	wretchSettingsQuery,
} from './settings.scope.ts'

type HeaderRow = { id: number; name: string; value: string }

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

function rowsOf(snapshot: WretchManagedSettingsSnapshot): HeaderRow[] {
	return Object.entries(snapshot.settings.headers).map(([name, value], id) => ({ id, name, value }))
}

function timeoutLabel(timeoutMs: number): string {
	return timeoutMs > 0 ? `${timeoutMs} ms` : '关闭'
}

function WretchSettingsPanel() {
	const { host } = settingsScope.useWorkbench()
	const snapshotQuery = wretchSettingsQuery.useQuery()
	const updateSettings = updateWretchSettingsMutation.useMutation()
	const resetSettings = resetWretchSettingsMutation.useMutation()
	const [snapshot, setSnapshot] = useState<WretchManagedSettingsSnapshot>()
	const [headers, setHeaders] = useState<HeaderRow[]>([])
	const [proxyUrl, setProxyUrl] = useState('')
	const [timeoutMs, setTimeoutMs] = useState<number | string>('')
	const [nextId, setNextId] = useState(0)
	const [error, setError] = useState<string>()
	const hydrated = useRef(false)
	const dirty = useRef(false)
	const operationPending = useRef(false)
	const loading = snapshotQuery.isPending
	const saving = updateSettings.isPending || resetSettings.isPending
	const visibleError =
		error ?? (snapshotQuery.status === 'error' ? messageOf(snapshotQuery.error) : undefined)
	const editingDisabled = loading || saving || !snapshot

	const apply = useCallback((input: WretchManagedSettingsSnapshot) => {
		const rows = rowsOf(input)
		hydrated.current = true
		dirty.current = false
		setSnapshot(input)
		setHeaders(rows)
		setNextId(rows.length)
		setProxyUrl(input.settings.proxyUrl ?? '')
		setTimeoutMs(input.settings.timeoutMs ?? '')
	}, [])

	useEffect(() => {
		// Background refetches must not replace an unsaved draft. Mutation results are applied
		// directly below, so a late invalidation refetch is only useful while the draft is clean.
		if (snapshotQuery.data && (!hydrated.current || !dirty.current)) apply(snapshotQuery.data)
	}, [apply, snapshotQuery.data])

	const markDirty = () => {
		dirty.current = true
	}

	const updateHeader = (id: number, patch: Partial<HeaderRow>) => {
		markDirty()
		setHeaders((current) => current.map((row) => (row.id === id ? { ...row, ...patch } : row)))
	}

	const save = async () => {
		if (!snapshot || operationPending.current) return
		const headerRecord: Record<string, string> = {}
		const headerNames = new Set<string>()
		for (const row of headers) {
			const name = row.name.trim()
			if (!name) continue
			const canonical = name.toLowerCase()
			if (headerNames.has(canonical)) {
				setError(`请求头“${name}”重复`)
				return
			}
			headerNames.add(canonical)
			headerRecord[name] = row.value
		}
		try {
			if (
				timeoutMs !== '' &&
				(typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs <= 0)
			) {
				throw new RangeError('请求超时必须是正整数')
			}
			operationPending.current = true
			const normalizedProxyUrl = proxyUrl.trim() || undefined
			const next = await updateSettings.mutateAsync({
				headers: headerRecord,
				...(normalizedProxyUrl === undefined ? {} : { proxyUrl: normalizedProxyUrl }),
				...(timeoutMs === '' ? {} : { timeoutMs }),
			})
			apply(next)
			setError(undefined)
		} catch (caught) {
			setError(messageOf(caught))
		} finally {
			operationPending.current = false
		}
	}

	const reset = async () => {
		if (operationPending.current) return
		try {
			operationPending.current = true
			const next = await resetSettings.mutateAsync()
			apply(next)
			setError(undefined)
		} catch (caught) {
			setError(messageOf(caught))
		} finally {
			operationPending.current = false
		}
	}

	return (
		<MantineProvider forceColorScheme={host.colorScheme}>
			<Stack gap="md" p="md">
				<Stack gap={2}>
					<Title order={4}>HTTP 设置</Title>
					<Text size="sm" c="dimmed">
						这些运行时覆盖项由 @pluxel/wretch 统一保存，并在每次请求发送前自动应用。
					</Text>
				</Stack>

				{visibleError ? <Alert color="red">{visibleError}</Alert> : null}

				<Card withBorder radius="md">
					<Stack gap="md">
						<TextInput
							label="HTTP(S) 代理"
							description="这里只接受不含路径和凭据的代理地址；暂不支持带凭据代理。"
							placeholder="http://proxy.example:8080"
							value={proxyUrl}
							disabled={editingDisabled}
							onChange={(event) => {
								markDirty()
								setProxyUrl(event.currentTarget.value)
							}}
						/>
						<NumberInput
							label="请求超时"
							description={
								snapshot
									? snapshot.hostTimeoutMs > 0
										? `宿主上限 ${snapshot.hostTimeoutMs} ms；当前实际 ${timeoutLabel(snapshot.effectiveTimeoutMs)}。`
										: `宿主未设置上限；当前实际 ${timeoutLabel(snapshot.effectiveTimeoutMs)}。`
									: '正在加载宿主策略…'
							}
							min={1}
							max={snapshot && snapshot.hostTimeoutMs > 0 ? snapshot.hostTimeoutMs : undefined}
							step={1_000}
							value={timeoutMs}
							disabled={editingDisabled}
							onChange={(value) => {
								markDirty()
								setTimeoutMs(value)
							}}
						/>
					</Stack>
				</Card>

				<Card withBorder radius="md">
					<Stack gap="sm">
						<Group justify="space-between">
							<Stack gap={0}>
								<Text fw={600}>运行时覆盖请求头</Text>
								<Text size="xs" c="dimmed">
									同名值会覆盖 consumer 代码中的普通请求头；Authorization、Cookie、
									Proxy-Authorization 和 X-API-Key 不在这里保存。
								</Text>
							</Stack>
							<Button
								variant="light"
								size="xs"
								disabled={editingDisabled}
								leftSection={<IconPlus size={14} />}
								onClick={() => {
									markDirty()
									setHeaders((current) => [...current, { id: nextId, name: '', value: '' }])
									setNextId((current) => current + 1)
								}}
							>
								添加
							</Button>
						</Group>

						<Table>
							<Table.Thead>
								<Table.Tr>
									<Table.Th>Header</Table.Th>
									<Table.Th>Value</Table.Th>
									<Table.Th w={48} />
								</Table.Tr>
							</Table.Thead>
							<Table.Tbody>
								{headers.map((row) => (
									<Table.Tr key={row.id}>
										<Table.Td>
											<TextInput
												placeholder="Accept-Language"
												value={row.name}
												disabled={editingDisabled}
												onChange={(event) =>
													updateHeader(row.id, { name: event.currentTarget.value })
												}
											/>
										</Table.Td>
										<Table.Td>
											<TextInput
												value={row.value}
												disabled={editingDisabled}
												onChange={(event) =>
													updateHeader(row.id, { value: event.currentTarget.value })
												}
											/>
										</Table.Td>
										<Table.Td>
											<Button
												variant="subtle"
												color="red"
												px="xs"
												disabled={editingDisabled}
												onClick={() => {
													markDirty()
													setHeaders((current) => current.filter((item) => item.id !== row.id))
												}}
											>
												<IconTrash size={16} />
											</Button>
										</Table.Td>
									</Table.Tr>
								))}
							</Table.Tbody>
						</Table>
					</Stack>
				</Card>

				<Group>
					<Button
						loading={loading || saving}
						disabled={loading || !snapshot}
						leftSection={<IconDeviceFloppy size={16} />}
						onClick={() => void save()}
					>
						保存并应用
					</Button>
					<Button
						variant="light"
						disabled={loading || saving}
						leftSection={<IconRestore size={16} />}
						onClick={() => void reset()}
					>
						恢复默认
					</Button>
				</Group>
			</Stack>
		</MantineProvider>
	)
}

export default settingsScope.render(WretchSettingsPanel)
