import { ActionIcon, Badge, Box, Group, Paper, Select, Stack, Text, Tooltip } from '@mantine/core'
import {
	formatPluginDefinitionReference,
	pluginNodeIndexKey,
	type PluginNodeAddress,
} from '@pluxel/core'
import { IconRefresh, IconStar } from '@tabler/icons-react'
import { useCallback, useEffect, useMemo } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
	runtimeErrorMessage,
	useRuntimeManagementClient,
	type PluginProviderPolicyInfo,
} from '../../../../runtime'
import { useNotify } from '../../../hooks/useNotify'
import { usePluginScope } from '../context'
import { managementQueryKeys, refetchManagementQuery } from '../../../managementQuery'

export function ProviderPolicyCard() {
	const { owner, refetch } = usePluginScope()
	const ownerKey = pluginNodeIndexKey(owner)
	const management = useRuntimeManagementClient()
	const queryClient = useQueryClient()
	const notify = useNotify()
	const policyQuery = useQuery<PluginProviderPolicyInfo>({
		queryKey: managementQueryKeys.providerPolicy(owner),
		queryFn: async () => {
			const result = await management.dependencies.inspectProviderPolicy(owner)
			if (result.ok === false) throw new Error(result.error)
			return result.value
		},
	})
	const policy = policyQuery.data ?? null
	const loading = policyQuery.isFetching
	useEffect(() => {
		if (!policyQuery.error) return
		notify({
			title: '读取提供方策略失败',
			message: runtimeErrorMessage(policyQuery.error, '无法读取提供方策略'),
			color: 'red',
		})
	}, [notify, policyQuery.error])

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

	const updatePolicy = useMutation({
		mutationKey: ['management', 'dependencies', 'set-provider-policy', ownerKey],
		mutationFn: async (provider: PluginNodeAddress | null) => {
			const result = await management.dependencies.setProviderPolicyDefault({
				policyOwner: owner,
				provider,
			})
			if (result.ok === false) {
				if (result.state === 'unknown') {
					await Promise.all([policyQuery.refetch(), refetch()])
				}
				throw new Error(result.error || result.code || '操作失败')
			}
			await Promise.all([
				refetchManagementQuery(queryClient, managementQueryKeys.providerPolicy(owner)),
				refetch(),
			])
			return provider
		},
		onSuccess: (provider) => {
			notify({
				title: '已更新默认实现',
				message: provider
					? (optionsByKey.get(pluginNodeIndexKey(provider))?.displayName ??
						provider.definition.exportName)
					: '未设置',
				color: 'green',
			})
		},
		onError: (error) => {
			notify({
				title: '更新失败',
				message: runtimeErrorMessage(error, '操作失败'),
				color: 'red',
			})
		},
	})
	const pending = updatePolicy.isPending

	const handleChange = useCallback(
		(value: string | null) => {
			if (!policy || pending) return
			const provider: PluginNodeAddress | null = value
				? (optionsByKey.get(value)?.address ?? null)
				: null
			if (value && !provider) return
			updatePolicy.mutate(provider)
		},
		[optionsByKey, pending, policy, updatePolicy],
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
						onClick={() => void policyQuery.refetch()}
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
