import { ActionIcon, Badge, Box, Group, Paper, Select, Stack, Text, Tooltip } from '@mantine/core'
import {
	formatPluginDefinitionReference,
	formatPluginNodeReference,
	pluginNodeIndexKey,
	type PluginNodeAddress,
} from '@pluxel/core'
import { IconRefresh, IconStar } from '@tabler/icons-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
	inspectPluginBaseProvider,
	rpcErrorMessage,
	selectPluginBaseProvider,
	useRuntimeTransportClient,
	type BaseProviderInfo,
} from '../../../../runtime'
import { useNotify } from '../../../hooks/useNotify'
import { usePluginScope } from '../context'

export function BaseProviderCard() {
	const { owner, refetch } = usePluginScope()
	const ownerKey = pluginNodeIndexKey(owner)
	const transport = useRuntimeTransportClient()
	const notify = useNotify()
	const [infoByOwner, setInfoByOwner] = useState(() => new Map<string, BaseProviderInfo | null>())
	const [loadingOwners, setLoadingOwners] = useState(() => new Set<string>())
	const requestIdsRef = useRef(new Map<string, number>())
	const mountedRef = useRef(true)
	const info = infoByOwner.get(ownerKey) ?? null
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
			const result = await transport.withRpc((rpc) => inspectPluginBaseProvider(rpc, owner))
			if (!mountedRef.current || requestIdsRef.current.get(ownerKey) !== requestId) return
			setInfoByOwner((previous) => new Map(previous).set(ownerKey, result ?? null))
		} catch (error) {
			if (!mountedRef.current || requestIdsRef.current.get(ownerKey) !== requestId) return
			setInfoByOwner((previous) => new Map(previous).set(ownerKey, null))
			notify({
				title: '读取提供者信息失败',
				message: rpcErrorMessage(error, '无法读取 provider 信息'),
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

	const providersByKey = useMemo(
		() =>
			new Map(
				(info?.providers ?? []).map((provider) => [pluginNodeIndexKey(provider.address), provider]),
			),
		[info?.providers],
	)
	const selectData = useMemo(
		() =>
			(info?.providers ?? []).map((provider) => ({
				value: pluginNodeIndexKey(provider.address),
				label: provider.isEnabled ? provider.displayName : `${provider.displayName} (disabled)`,
			})),
		[info?.providers],
	)

	const handleChange = useCallback(
		async (value: string | null) => {
			if (!info) return
			const provider: PluginNodeAddress | null = value
				? (providersByKey.get(value)?.address ?? null)
				: null
			if (value && !provider) return
			try {
				const result = await transport.withRpc((rpc) =>
					selectPluginBaseProvider(rpc, {
						consumer: owner,
						token: info.token,
						provider,
					}),
				)
				if (result.ok === false) throw new Error(result.error || result.code || '操作失败')
				await load()
				await refetch()
				notify({
					title: '已更新默认实现',
					message: `${formatPluginDefinitionReference(info.token)} → ${provider ? formatPluginNodeReference(provider) : '未设置'}`,
					color: 'green',
				})
			} catch (error) {
				notify({ title: '更新失败', message: rpcErrorMessage(error, '操作失败'), color: 'red' })
			}
		},
		[info, load, notify, owner, providersByKey, refetch, transport],
	)

	if (!info) return null
	const tokenLabel = formatPluginDefinitionReference(info.token)
	const currentLabel = info.currentDefault
		? formatPluginNodeReference(info.currentDefault)
		: '未设置'

	return (
		<Paper
			withBorder
			radius="sm"
			p="sm"
			shadow="none"
			style={{
				borderColor: info.isDefault ? 'var(--plx-accent)' : 'var(--plx-panel-border-strong)',
			}}
		>
			<Group justify="space-between" align="flex-start" wrap="nowrap">
				<Stack gap={4} style={{ minWidth: 0 }}>
					<Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
						<Badge
							variant={info.isDefault ? 'filled' : 'light'}
							color={info.isDefault ? 'green' : 'gray'}
							radius="sm"
							size="sm"
							leftSection={info.isDefault ? <IconStar size={12} /> : undefined}
						>
							提供抽象依赖
						</Badge>
						<Text size="sm" fw={600} ff="monospace" lineClamp={1}>
							{tokenLabel}
						</Text>
					</Group>
					<Text size="xs" c="dimmed" lineClamp={2}>
						当前默认：{currentLabel}（全局生效）
					</Text>
				</Stack>
				<Tooltip label={loading ? '加载中…' : '刷新'} withArrow>
					<ActionIcon size="sm" variant="subtle" onClick={() => void load()} disabled={loading}>
						<IconRefresh size={14} />
					</ActionIcon>
				</Tooltip>
			</Group>
			<Box mt="sm">
				<Select
					size="sm"
					label="设置默认实现（全局）"
					data={selectData}
					value={info.currentDefault ? pluginNodeIndexKey(info.currentDefault) : null}
					onChange={(value) => void handleChange(value)}
					disabled={loading}
					clearable
					searchable
					nothingFoundMessage="暂无可选项"
				/>
			</Box>
		</Paper>
	)
}
