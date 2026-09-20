import { Badge, Box, Group, Select, Stack, Text } from '@mantine/core'
import {
	formatPluginDefinitionReference,
	pluginNodeIndexKey,
	type PluginNodeAddress,
} from '@pluxel/core'
import { useCallback, useMemo } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import {
	runtimeErrorMessage,
	useRuntimeManagementClient,
	type PluginProviderPolicyInfo,
} from '../../../../runtime'
import { useNotify } from '../../../hooks/useNotify'
import { usePluginScope } from '../context'
import { managementQueryKeys } from '../../../managementQuery'

export function usePluginProviderPolicy(refresh: () => Promise<void>) {
	const { owner } = usePluginScope()
	const ownerKey = pluginNodeIndexKey(owner)
	const management = useRuntimeManagementClient()
	const notify = useNotify()
	const policyQuery = useQuery<PluginProviderPolicyInfo | null>({
		queryKey: managementQueryKeys.providerPolicy(owner),
		queryFn: async () => {
			const result = await management.dependencies.inspectProviderPolicy(owner)
			if (result.ok === false) throw new Error(result.error)
			return result.value
		},
	})
	const policy = policyQuery.data ?? null
	const loading = policyQuery.isFetching

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
				throw new Error(result.error || result.code || '操作失败')
			}
			return provider
		},
		onSettled: () => refresh(),
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

	return { policy, loading, pending, selectData, handleChange, error: policyQuery.error }
}

export function PluginProvidedCapability({
	control,
}: {
	control: ReturnType<typeof usePluginProviderPolicy>
}) {
	const { policy, loading, pending, selectData, handleChange, error } = control
	if (!policy && !loading && !error) return null
	const tokenLabel = policy ? formatPluginDefinitionReference(policy.token) : undefined
	return (
		<section className="plx-pluginDependencyDetail__section">
			<div className="plx-pluginDependencyDetail__sectionHeader">
				<Text component="h3" className="plx-pluginDependencyDetail__sectionTitle">
					提供的能力
				</Text>
			</div>
			{error ? (
				<Text size="xs" c="red">
					{runtimeErrorMessage(error, '读取提供的能力失败')}
				</Text>
			) : null}
			{!policy && loading ? (
				<Text size="xs" c="dimmed">
					加载中…
				</Text>
			) : null}
			{policy ? (
				<Stack gap="xs">
					<Group gap="xs">
						<Text size="sm" fw={600} title={tokenLabel}>
							{policy.token.exportName}
						</Text>
						{policy.policyOwnerIsDefault ? (
							<Badge color="green" size="xs" radius="sm">
								全局默认提供者
							</Badge>
						) : null}
					</Group>
					<Box>
						<Select
							size="xs"
							label="全局默认实现"
							description="影响所有依赖此能力且未单独指定实现的插件。"
							data={selectData}
							value={policy.defaultProvider ? pluginNodeIndexKey(policy.defaultProvider) : null}
							onChange={handleChange}
							disabled={loading || pending}
							clearable
							searchable
							placeholder="未设置"
							nothingFoundMessage="暂无可选项"
						/>
					</Box>
				</Stack>
			) : null}
		</section>
	)
}
