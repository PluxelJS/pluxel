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
import {
	formatPluginDefinitionAddress,
	formatPluginNodeAddress,
	type PluginNodeAddressSnapshot,
} from '@pluxel/core'
import { IconPlus, IconRefresh } from '@tabler/icons-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
	ensurePluginFork,
	inspectPluginDependencies,
	rpcErrorMessage,
	setPluginDependencyTarget,
	useRuntimeTransportClient,
	type PluginDependencyState,
} from '../../../../runtime'
import { workbenchNodeKey } from '../../../../workbench/node-address'
import { useNotify } from '../../../hooks/useNotify'
import { usePluginScope } from '../context'

function kindLabel(kind: PluginDependencyState['kind']) {
	return kind === 'abstract'
		? { label: '抽象依赖', color: 'indigo' }
		: { label: '插件依赖', color: 'gray' }
}

export function DependencyOverridesCard() {
	const { owner, refetch } = usePluginScope()
	const ownerKey = workbenchNodeKey(owner)
	const transport = useRuntimeTransportClient()
	const notify = useNotify()
	const [stateByOwner, setStateByOwner] = useState(() => new Map<string, PluginDependencyState[]>())
	const [loadingOwners, setLoadingOwners] = useState(() => new Set<string>())
	const requestIdsRef = useRef(new Map<string, number>())
	const mountedRef = useRef(true)
	const state = stateByOwner.get(ownerKey) ?? null
	const loading = loadingOwners.has(ownerKey)

	useEffect(
		() => () => {
			mountedRef.current = false
		},
		[],
	)

	const load = useCallback(async () => {
		const requestId = (requestIdsRef.current.get(ownerKey) ?? 0) + 1
		requestIdsRef.current.set(ownerKey, requestId)
		setLoadingOwners((previous) => new Set(previous).add(ownerKey))
		try {
			const dependencies = await transport.withRpc((rpc) => inspectPluginDependencies(rpc, owner))
			if (!mountedRef.current || requestIdsRef.current.get(ownerKey) !== requestId) return
			const rows = dependencies.filter(
				(row) => row.kind === 'abstract' || row.options.length > 1 || row.selected !== null,
			)
			setStateByOwner((previous) => new Map(previous).set(ownerKey, rows))
		} catch (error) {
			if (!mountedRef.current || requestIdsRef.current.get(ownerKey) !== requestId) return
			setStateByOwner((previous) => new Map(previous).set(ownerKey, []))
			notify({
				title: '读取依赖失败',
				message: rpcErrorMessage(error, '无法读取依赖状态'),
				color: 'red',
			})
		} finally {
			if (mountedRef.current && requestIdsRef.current.get(ownerKey) === requestId) {
				setLoadingOwners((previous) => {
					const next = new Set(previous)
					next.delete(ownerKey)
					return next
				})
			}
		}
	}, [notify, owner, ownerKey, transport])

	useEffect(() => {
		void load()
	}, [load])

	const rows = useMemo(() => state ?? [], [state])
	const triggerRefresh = useCallback(async () => {
		await load()
		await refetch()
	}, [load, refetch])

	const setDependencyTarget = useCallback(
		async (index: number, provider: PluginNodeAddressSnapshot | null) => {
			const result = await transport.withRpc((rpc) =>
				setPluginDependencyTarget(rpc, {
					consumer: owner,
					index,
					provider,
				}),
			)
			if (!result.ok) throw new Error(result.error || result.code || '操作失败')
		},
		[owner, transport],
	)

	const createFork = useCallback(
		async (base: PluginNodeAddressSnapshot, forkId: string): Promise<PluginNodeAddressSnapshot> => {
			const result = await transport.withRpc((rpc) =>
				ensurePluginFork(rpc, { base, forkId, enable: true }),
			)
			if (!result.ok || !result.fork)
				throw new Error(result.error || result.code || '创建 fork 失败')
			return result.fork
		},
		[transport],
	)

	const handleForkCreate = useCallback(
		(row: PluginDependencyState) => {
			const base =
				row.options.find((option) => option.address.instance === 'default') ?? row.options[0]
			if (!base) return
			let forkId = ''
			openConfirmModal({
				title: '创建 Fork',
				children: (
					<Box>
						<Text size="sm" c="dimmed">
							为{' '}
							<Text component="span" fw={600}>
								{base.displayName}
							</Text>{' '}
							创建新的 forkId。
						</Text>
						<TextInput
							autoFocus
							mt="sm"
							placeholder="例如：worker-1"
							onChange={(event) => {
								forkId = event.currentTarget.value
							}}
							styles={{ input: { fontFamily: 'var(--mantine-font-monospace)' } }}
						/>
					</Box>
				),
				labels: { confirm: '创建并选择', cancel: '取消' },
				onConfirm: () => {
					void (async () => {
						try {
							const normalizedForkId = forkId.trim()
							if (!normalizedForkId) throw new Error('forkId 不能为空')
							const fork = await createFork(base.address, normalizedForkId)
							await setDependencyTarget(row.index, fork)
							await triggerRefresh()
							notify({
								title: 'Fork 已创建',
								message: formatPluginNodeAddress(fork),
								color: 'green',
							})
						} catch (error) {
							notify({
								title: '创建 Fork 失败',
								message: rpcErrorMessage(error, '操作失败'),
								color: 'red',
							})
						}
					})()
				},
			})
		},
		[createFork, notify, setDependencyTarget, triggerRefresh],
	)

	if (state === null || rows.length === 0) return null

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
				{rows.map((row, index) => {
					const kind = kindLabel(row.kind)
					const optionsByKey = new Map(
						row.options.map((option) => [workbenchNodeKey(option.address), option]),
					)
					const selectData = row.options.map((option) => ({
						value: workbenchNodeKey(option.address),
						label: option.isEnabled ? option.displayName : `${option.displayName} (disabled)`,
					}))
					const tokenLabel = formatPluginDefinitionAddress(row.token)
					const effectiveLabel = row.effective ? formatPluginNodeAddress(row.effective) : '未解析'
					const defaultLabel = row.providerDefault
						? formatPluginNodeAddress(row.providerDefault)
						: '未设置'
					return (
						<Box key={`${row.index}:${tokenLabel}`} style={{ minWidth: 0 }}>
							<Stack gap={6}>
								<Group gap="xs" align="center" wrap="wrap">
									<Badge variant="light" color={kind.color} radius="sm" size="sm">
										{kind.label}
									</Badge>
									<Text
										size="sm"
										fw={600}
										ff="monospace"
										style={{ flex: 1, minWidth: 220 }}
										lineClamp={1}
									>
										{tokenLabel}
									</Text>
									<Badge
										variant="light"
										color={row.isRunning ? 'green' : 'gray'}
										radius="sm"
										size="xs"
									>
										{row.isRunning ? 'running' : 'stopped'}
									</Badge>
								</Group>
								<Text size="xs" c="dimmed">
									当前注入：{effectiveLabel}；全局默认：{defaultLabel}
								</Text>
								<Group gap="xs" align="flex-end" wrap="wrap">
									<Box style={{ flex: 1, minWidth: 260 }}>
										<Select
											size="xs"
											label="覆盖（仅当前节点）"
											placeholder="留空以使用运行时默认解析"
											data={selectData}
											value={row.selected ? workbenchNodeKey(row.selected) : null}
											onChange={(value) => {
												const provider = value ? (optionsByKey.get(value)?.address ?? null) : null
												void (async () => {
													try {
														await setDependencyTarget(row.index, provider)
														await triggerRefresh()
														notify({
															title: '已更新覆盖',
															message: `${tokenLabel} → ${provider ? formatPluginNodeAddress(provider) : '默认'}`,
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
											searchable
											nothingFoundMessage="暂无可选项"
										/>
									</Box>
									<Tooltip label="从一个实现创建 Fork" withArrow>
										<ActionIcon
											size="sm"
											variant="light"
											onClick={() => handleForkCreate(row)}
											disabled={loading || row.options.length === 0}
										>
											<IconPlus size={14} />
										</ActionIcon>
									</Tooltip>
								</Group>
							</Stack>
							{index < rows.length - 1 ? <Divider my="sm" /> : null}
						</Box>
					)
				})}
			</Stack>
		</Paper>
	)
}
