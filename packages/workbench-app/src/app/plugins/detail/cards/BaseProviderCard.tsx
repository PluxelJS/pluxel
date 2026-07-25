import { ActionIcon, Badge, Box, Group, Paper, Select, Stack, Text, Tooltip } from '@mantine/core'
import { IconRefresh, IconStar } from '@tabler/icons-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
	inspectPluginBaseProvider,
	rpcErrorMessage,
	selectPluginBaseProvider,
	useRuntimeTransportClient,
	type BaseProviderInfo,
	type PluginDependencyMutationResult,
} from '../../../../runtime'
import { useNotify } from '../../../hooks/useNotify'
import { usePluginScope } from '../context'

export function BaseProviderCard() {
	const { pluginName, refetch } = usePluginScope()
	const transport = useRuntimeTransportClient()
	const notify = useNotify()
	const [infoByPlugin, setInfoByPlugin] = useState(() => new Map<string, BaseProviderInfo | null>())
	const [loadingPlugins, setLoadingPlugins] = useState(() => new Set<string>())
	const requestIdsRef = useRef(new Map<string, number>())
	const mountedRef = useRef(true)
	const info = infoByPlugin.get(pluginName) ?? null
	const loading = loadingPlugins.has(pluginName)

	useEffect(() => {
		return () => {
			mountedRef.current = false
		}
	}, [])

	const load = useCallback(async () => {
		if (!pluginName) return
		const requestId = (requestIdsRef.current.get(pluginName) ?? 0) + 1
		requestIdsRef.current.set(pluginName, requestId)
		setLoadingPlugins((prev) => new Set(prev).add(pluginName))
		try {
			const res = await transport.withRpc((rpc) => inspectPluginBaseProvider(rpc, pluginName))
			if (!mountedRef.current || requestIdsRef.current.get(pluginName) !== requestId) return
			setInfoByPlugin((prev) => new Map(prev).set(pluginName, res ?? null))
		} catch (error) {
			if (!mountedRef.current || requestIdsRef.current.get(pluginName) !== requestId) return
			setInfoByPlugin((prev) => new Map(prev).set(pluginName, null))
			notify({
				title: '读取提供者信息失败',
				message: rpcErrorMessage(error, '无法读取 base provider 信息'),
				color: 'red',
			})
		} finally {
			if (mountedRef.current && requestIdsRef.current.get(pluginName) === requestId) {
				setLoadingPlugins((prev) => {
					const next = new Set(prev)
					next.delete(pluginName)
					return next
				})
			}
		}
	}, [transport, notify, pluginName])

	useEffect(() => {
		void load()
	}, [load])

	const selectData = useMemo(() => {
		const providers = info?.providers ?? []
		return providers.map((p) => ({
			value: p.name,
			label: p.isEnabled ? p.name : `${p.name} (disabled)`,
		}))
	}, [info?.providers])

	const handleChange = useCallback(
		async (value: string | null) => {
			if (!pluginName || !info) return
			if (!value) return
			try {
				const res = await transport.withRpc(
					(rpc) =>
						selectPluginBaseProvider(rpc, {
							name: pluginName,
							baseToken: info.baseToken,
							providerName: value,
						}) as Promise<PluginDependencyMutationResult>,
				)
				if (!res.ok) throw new Error(res.error || res.code || '操作失败')
				await load()
				await refetch()
				notify({
					title: '已更新默认实现',
					message: `${info.baseToken} → ${value}`,
					color: 'green',
				})
			} catch (error) {
				notify({
					title: '更新失败',
					message: rpcErrorMessage(error, '操作失败'),
					color: 'red',
				})
			}
		},
		[transport, info, load, notify, pluginName, refetch],
	)

	if (!info) return null

	const highlight = info.isDefault
	const borderColor = highlight ? 'var(--plx-accent)' : 'var(--plx-panel-border-strong)'

	return (
		<Paper withBorder radius="sm" p="sm" shadow="none" style={{ borderColor }}>
			<Group justify="space-between" align="flex-start" wrap="nowrap">
				<Stack gap={4} style={{ minWidth: 0 }}>
					<Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
						<Badge
							variant={highlight ? 'filled' : 'light'}
							color={highlight ? 'green' : 'gray'}
							radius="sm"
							size="sm"
							leftSection={highlight ? <IconStar size={12} /> : undefined}
						>
							提供基类
						</Badge>
						<Text
							size="sm"
							fw={600}
							style={{ fontFamily: 'var(--mantine-font-monospace)' }}
							lineClamp={1}
						>
							{info.baseToken}
						</Text>
					</Group>
					<Text size="xs" c="dimmed" lineClamp={2}>
						当前默认：{info.currentDefault ?? '未设置'}（全局生效）
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
					description="选择哪个实现插件来绑定该基类的注入 token"
					data={selectData}
					value={info.currentDefault}
					onChange={(v) => void handleChange(v)}
					disabled={loading}
					nothingFoundMessage="暂无可选项"
					searchable
				/>
			</Box>
		</Paper>
	)
}
