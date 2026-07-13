import {
	ActionIcon,
	Badge,
	Box,
	Divider,
	Group,
	Paper,
	Select,
	Stack,
	Text,
	TextInput,
	Tooltip,
} from '@mantine/core'
import { openConfirmModal } from '@mantine/modals'
import { IconPlus, IconRefresh } from '@tabler/icons-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNotify } from '../../../hooks/useNotify'
import {
	ensurePluginFork,
	inspectPluginDependencies,
	rpcErrorMessage,
	setPluginDependencyTarget,
	useRuntimeTransportClient,
	type EnsureForkResult,
	type PluginDependencyMutationResult,
	type PluginDependencyState,
} from '../../../../runtime'
import { usePluginScope } from '../context'

function runtimeColor(isRunning: boolean) {
	return isRunning ? 'green' : 'gray'
}

function kindLabel(kind: PluginDependencyState['kind']) {
	switch (kind) {
		case 'base':
			return { label: '基类', color: 'indigo' }
		case 'forkable':
			return { label: 'Fork', color: 'violet' }
		default:
			return { label: '依赖', color: 'gray' }
	}
}

export function DependencyOverridesCard() {
	const { pluginName, refetch } = usePluginScope()
	const transport = useRuntimeTransportClient()
	const notify = useNotify()
	const [state, setState] = useState<PluginDependencyState[] | null>(null)
	const [loading, setLoading] = useState(false)
	const mountedRef = useRef(true)

	useEffect(() => {
		mountedRef.current = true
		return () => {
			mountedRef.current = false
		}
	}, [])

	const load = useCallback(async () => {
		if (!pluginName) return
		setLoading(true)
		try {
			const deps = await transport.withRpc((rpc) => inspectPluginDependencies(rpc, pluginName))
			if (!mountedRef.current) return
			const rows = Array.isArray(deps) ? deps : []
			// 仅在“可操作”的依赖存在时展示：base/forkable 才需要注入选择；
			// 普通插件依赖已经在“依赖”列表里表达，无需重复一份 UI。
			setState(rows.filter((row) => row.kind === 'base' || row.kind === 'forkable'))
		} catch (error) {
			if (!mountedRef.current) return
			setState([])
			notify({
				title: '读取依赖失败',
				message: rpcErrorMessage(error, '无法读取依赖状态'),
				color: 'red',
			})
		} finally {
			if (mountedRef.current) setLoading(false)
		}
	}, [transport, notify, pluginName])

	useEffect(() => {
		void load()
	}, [load])

	const rows = useMemo(() => state ?? [], [state])

	const triggerRefresh = useCallback(async () => {
		await load()
		await refetch()
	}, [load, refetch])

	const setDependencyTarget = useCallback(
		async (index: number, next: string | null) => {
			const res = await transport.withRpc(
				(rpc) =>
					setPluginDependencyTarget(rpc, {
						name: pluginName,
						index,
						targetName: next,
					}) as Promise<PluginDependencyMutationResult>,
			)
			if (!res.ok) throw new Error(res.error || res.code || '操作失败')
		},
		[transport, pluginName],
	)

	const ensureFork = useCallback(
		async (baseName: string, forkId: string) => {
			const res = await transport.withRpc(
				(rpc) =>
					ensurePluginFork(rpc, {
						baseName,
						forkId,
						enable: true,
					}) as Promise<EnsureForkResult>,
			)
			if (!res.ok) throw new Error(res.error || res.code || '创建 fork 失败')
			return res.forkName ?? `${baseName}#${forkId}`
		},
		[transport, pluginName],
	)

	const handleForkCreate = useCallback(
		(row: PluginDependencyState) => {
			const baseName = row.options[0]?.name
			if (!baseName) return
			let forkId = ''
			openConfirmModal({
				title: '创建 Fork',
				children: (
					<Box>
						<Text size="sm" c="dimmed">
							为{' '}
							<Text component="span" fw={600}>
								{baseName}
							</Text>{' '}
							创建新的 forkId。
						</Text>
						<TextInput
							autoFocus
							mt="sm"
							placeholder="例如：a / worker-1"
							onChange={(e) => {
								forkId = e.currentTarget.value
							}}
							styles={{
								input: { fontFamily: 'var(--mantine-font-monospace)' },
							}}
						/>
					</Box>
				),
				labels: { confirm: '创建并选择', cancel: '取消' },
				onConfirm: async () => {
					try {
						const fid = forkId.trim()
						if (!fid) throw new Error('forkId 不能为空')
						const forkName = await ensureFork(baseName, fid)
						await setDependencyTarget(row.index, forkName)
						await triggerRefresh()
						notify({ title: 'Fork 已创建', message: forkName, color: 'green' })
					} catch (error) {
						notify({
							title: '创建 Fork 失败',
							message: rpcErrorMessage(error, '操作失败'),
							color: 'red',
						})
					}
				},
			})
		},
		[ensureFork, notify, setDependencyTarget, triggerRefresh],
	)

	if (!pluginName) return null
	// 初次加载时不渲染占位，避免“先显示空卡片/0 条，再突然出现/消失”导致重排。
	if (state === null) return null
	// 不可操作（仅普通插件依赖/无依赖）时直接隐藏整块，避免与“依赖”列表重复。
	if (rows.length === 0) return null

	return (
		<Paper withBorder radius="sm" p="sm" shadow="none">
			<Group justify="space-between" align="center" mb="xs">
				<Group gap="xs" align="center">
					<Text size="sm" fw={600}>
						依赖注入
					</Text>
					<Badge variant="light" color="gray" radius="sm" size="sm">
						{rows.length}
					</Badge>
				</Group>
				<Tooltip label={loading ? '加载中…' : '刷新'} withArrow>
					<ActionIcon
						size="sm"
						variant="subtle"
						onClick={() => void triggerRefresh()}
						disabled={loading}
					>
						<IconRefresh size={14} />
					</ActionIcon>
				</Tooltip>
			</Group>

			<Stack gap="sm">
				{rows.map((row, idx) => {
					const kind = kindLabel(row.kind)
					const options = row.options ?? []
					const currentForkValue =
						row.kind === 'forkable' ? (row.selected ?? row.effective ?? null) : null

					const selectData = options.map((opt) => ({
						value: opt.name,
						label: opt.isEnabled ? opt.name : `${opt.name} (disabled)`,
					}))

					const handleForkChange = async (value: string | null) => {
						try {
							if (row.kind !== 'forkable') return
							const base = options[0]?.name
							if (value && base && value === base) await setDependencyTarget(row.index, null)
							else await setDependencyTarget(row.index, value)
							await triggerRefresh()
							notify({
								title: '已更新',
								message: `${row.token} → ${value ?? '默认'}`,
								color: 'green',
							})
						} catch (error) {
							notify({
								title: '更新失败',
								message: rpcErrorMessage(error, '操作失败'),
								color: 'red',
							})
						}
					}

					return (
						<Box key={`${row.index}:${row.token}`} style={{ minWidth: 0 }}>
							{row.kind === 'base' ? (
								<Stack gap={6}>
									<Group gap="xs" align="center" wrap="wrap">
										<Badge variant="light" color={kind.color} radius="sm" size="sm">
											{kind.label}
										</Badge>
										<Text
											size="sm"
											fw={600}
											style={{
												fontFamily: 'var(--mantine-font-monospace)',
												flex: 1,
												minWidth: 220,
											}}
											lineClamp={1}
										>
											{row.token}
										</Text>
										<Badge
											variant="light"
											color={runtimeColor(row.isRunning)}
											radius="sm"
											size="xs"
										>
											{row.isRunning ? 'running' : 'stopped'}
										</Badge>
									</Group>

									<Text size="xs" c="dimmed">
										当前注入：{row.effective}；全局默认：{row.baseProvider ?? '未设置'}
										（覆盖为空则使用全局默认）
									</Text>

									<Select
										size="xs"
										label="覆盖（仅本插件）"
										placeholder="选择实现插件（留空=全局默认）"
										data={selectData}
										value={row.selected ?? null}
										onChange={(v) => {
											const next = v && v === row.baseProvider ? null : v
											void (async () => {
												try {
													await setDependencyTarget(row.index, next)
													await triggerRefresh()
													notify({
														title: '已更新覆盖',
														message: `${row.token} → ${next ?? '默认'}`,
														color: 'green',
													})
												} catch (error) {
													notify({
														title: '更新失败',
														message: rpcErrorMessage(error, '操作失败'),
														color: 'red',
													})
												}
											})()
										}}
										clearable
										disabled={loading}
										nothingFoundMessage="暂无可选项"
										searchable
									/>
								</Stack>
							) : (
								<Stack gap={6}>
									<Group gap="xs" align="center" wrap="wrap">
										<Badge variant="light" color={kind.color} radius="sm" size="sm">
											{kind.label}
										</Badge>
										<Text
											size="sm"
											fw={600}
											style={{
												fontFamily: 'var(--mantine-font-monospace)',
												flex: 1,
												minWidth: 220,
											}}
											lineClamp={1}
										>
											{row.token}
										</Text>
										<Badge
											variant="light"
											color={runtimeColor(row.isRunning)}
											radius="sm"
											size="xs"
										>
											{row.isRunning ? 'running' : 'stopped'}
										</Badge>
									</Group>

									{row.kind === 'forkable' ? (
										<Text size="xs" c="dimmed">
											当前注入：{row.effective}（选择基类/清空 = 不覆盖）
										</Text>
									) : null}

									{row.kind === 'forkable' ? (
										<Group gap="xs" align="flex-end" wrap="wrap">
											<Box style={{ flex: 1, minWidth: 260 }}>
												<Select
													size="xs"
													label="选择 Fork"
													placeholder="选择 fork"
													data={selectData}
													value={currentForkValue}
													onChange={(v) => void handleForkChange(v)}
													clearable
													disabled={loading}
													nothingFoundMessage="暂无可选项"
													searchable
												/>
											</Box>
											<Tooltip label="创建 Fork" withArrow>
												<ActionIcon
													size="sm"
													variant="light"
													onClick={() => handleForkCreate(row)}
													disabled={loading}
												>
													<IconPlus size={14} />
												</ActionIcon>
											</Tooltip>
										</Group>
									) : null}
								</Stack>
							)}
							{idx < rows.length - 1 ? <Divider my="sm" /> : null}
						</Box>
					)
				})}
			</Stack>
		</Paper>
	)
}
