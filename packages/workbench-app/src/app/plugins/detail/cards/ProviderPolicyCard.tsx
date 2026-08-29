import { ActionIcon, Badge, Box, Group, Paper, Select, Stack, Text, Tooltip } from '@mantine/core'
import {
	formatPluginDefinitionReference,
	pluginNodeIndexKey,
	type PluginNodeAddress,
} from '@pluxel/core'
import { IconRefresh, IconStar } from '@tabler/icons-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
	runtimeErrorMessage,
	useRuntimeManagementClient,
	type PluginProviderPolicyInfo,
} from '../../../../runtime'
import { useNotify } from '../../../hooks/useNotify'
import { usePluginScope } from '../context'

export function ProviderPolicyCard() {
	const { owner, refetch } = usePluginScope()
	const ownerKey = pluginNodeIndexKey(owner)
	const management = useRuntimeManagementClient()
	const notify = useNotify()
	const [policyByOwner, setPolicyByOwner] = useState(
		() => new Map<string, PluginProviderPolicyInfo | null>(),
	)
	const [loadingOwners, setLoadingOwners] = useState(() => new Set<string>())
	const [pendingOwners, setPendingOwners] = useState(() => new Set<string>())
	const requestIdsRef = useRef(new Map<string, number>())
	const pendingOwnersRef = useRef(new Set<string>())
	const mountedRef = useRef(false)
	const policy = policyByOwner.get(ownerKey) ?? null
	const loading = loadingOwners.has(ownerKey)
	const pending = pendingOwners.has(ownerKey)

	useEffect(() => {
		mountedRef.current = true
		return () => {
			mountedRef.current = false
		}
	}, [])

	const load = useCallback(async () => {
		const requestId = (requestIdsRef.current.get(ownerKey) ?? 0) + 1
		requestIdsRef.current.set(ownerKey, requestId)
		setLoadingOwners((previous) => new Set(previous).add(ownerKey))
		try {
			const result = await management.dependencies.inspectProviderPolicy(owner)
			if (result.ok === false) throw new Error(result.error)
			if (!mountedRef.current || requestIdsRef.current.get(ownerKey) !== requestId) return
			setPolicyByOwner((previous) => new Map(previous).set(ownerKey, result.value))
		} catch (error) {
			if (!mountedRef.current || requestIdsRef.current.get(ownerKey) !== requestId) return
			setPolicyByOwner((previous) => new Map(previous).set(ownerKey, null))
			notify({
				title: '读取提供方策略失败',
				message: runtimeErrorMessage(error, '无法读取提供方策略'),
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
	}, [management.dependencies, notify, owner, ownerKey])

	useEffect(() => {
		void load()
	}, [load])

	const optionsByKey = useMemo(
		() =>
			new Map(
				(policy?.options ?? []).map((option) => [pluginNodeIndexKey(option.address), option]),
			),
		[policy?.options],
	)
	const selectData = useMemo(() => {
		const data = (policy?.options ?? []).map((option) => ({
			value: pluginNodeIndexKey(option.address),
			label:
				option.availability === 'available'
					? option.displayName
					: `${option.displayName}（当前不可用）`,
			disabled: option.availability === 'unavailable',
		}))
		if (policy?.defaultProvider && !optionsByKey.has(pluginNodeIndexKey(policy.defaultProvider))) {
			data.push({
				value: pluginNodeIndexKey(policy.defaultProvider),
				label: `${policy.defaultProvider.definition.exportName}（当前不可用）`,
				disabled: true,
			})
		}
		return data
	}, [optionsByKey, policy?.defaultProvider, policy?.options])

	const handleChange = useCallback(
		async (value: string | null) => {
			if (!policy || pendingOwnersRef.current.has(ownerKey)) return
			const provider: PluginNodeAddress | null = value
				? (optionsByKey.get(value)?.address ?? null)
				: null
			if (value && !provider) return
			pendingOwnersRef.current.add(ownerKey)
			setPendingOwners(new Set(pendingOwnersRef.current))
			try {
				const result = await management.dependencies.setProviderPolicyDefault({
					policyOwner: owner,
					provider,
				})
				if (result.ok === false) {
					if (result.state === 'unknown') {
						await load()
						await refetch()
					}
					throw new Error(result.error || result.code || '操作失败')
				}
				await load()
				await refetch()
				notify({
					title: '已更新默认实现',
					message: provider
						? (optionsByKey.get(pluginNodeIndexKey(provider))?.displayName ??
							provider.definition.exportName)
						: '未设置',
					color: 'green',
				})
			} catch (error) {
				notify({
					title: '更新失败',
					message: runtimeErrorMessage(error, '操作失败'),
					color: 'red',
				})
			} finally {
				pendingOwnersRef.current.delete(ownerKey)
				if (mountedRef.current) setPendingOwners(new Set(pendingOwnersRef.current))
			}
		},
		[policy, load, management.dependencies, notify, owner, ownerKey, optionsByKey, refetch],
	)

	if (!policy) return null
	const tokenLabel = formatPluginDefinitionReference(policy.token)
	const currentLabel = policy.defaultProvider
		? (optionsByKey.get(pluginNodeIndexKey(policy.defaultProvider))?.displayName ??
			policy.defaultProvider.definition.exportName)
		: '未设置'

	return (
		<Paper
			withBorder
			radius="sm"
			p="sm"
			shadow="none"
			style={{
				borderColor: policy.policyOwnerIsDefault
					? 'var(--plx-accent)'
					: 'var(--plx-panel-border-strong)',
			}}
		>
			<Group justify="space-between" align="flex-start" wrap="nowrap">
				<Stack gap={4} style={{ minWidth: 0 }}>
					<Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
						<Badge
							variant={policy.policyOwnerIsDefault ? 'filled' : 'light'}
							color={policy.policyOwnerIsDefault ? 'green' : 'gray'}
							radius="sm"
							size="sm"
							leftSection={policy.policyOwnerIsDefault ? <IconStar size={12} /> : undefined}
						>
							提供方默认
						</Badge>
						<Text size="sm" fw={600} lineClamp={1} title={tokenLabel}>
							{policy.token.exportName}
						</Text>
					</Group>
					<Text size="xs" c="dimmed" lineClamp={2}>
						当前全局默认：{currentLabel}。供未设置消费覆盖的 Plugin 跟随。
					</Text>
				</Stack>
				<Tooltip label={loading ? '加载中…' : '刷新'} withArrow>
					<ActionIcon
						size="sm"
						variant="subtle"
						onClick={() => void load()}
						disabled={loading || pending}
					>
						<IconRefresh size={14} />
					</ActionIcon>
				</Tooltip>
			</Group>
			<Box mt="sm">
				<Select
					size="sm"
					label="全局默认实现"
					data={selectData}
					value={policy.defaultProvider ? pluginNodeIndexKey(policy.defaultProvider) : null}
					onChange={(value) => void handleChange(value)}
					disabled={loading || pending}
					clearable
					searchable
					nothingFoundMessage="暂无可选项"
				/>
			</Box>
		</Paper>
	)
}
