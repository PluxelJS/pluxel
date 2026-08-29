import {
	pluginDefinitionIndexKey,
	pluginNodeIndexKey,
	type PluginDefinitionAddress,
	type PluginNodeAddress,
} from '@pluxel/core'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
	runtimeErrorMessage,
	useRuntimeManagementClient,
	type PluginConsumerRequirementState,
} from '../../../runtime'
import { usePluginScope } from './context'

export const FOLLOW_DEFAULT_VALUE = 'follow-default'
const PROVIDER_VALUE_PREFIX = 'provider:'

function providerOptionDisplayName(
	option: PluginConsumerRequirementState['options'][number],
): string {
	return option.address.variant === 'fork'
		? `${option.displayName} / ${option.address.forkId}`
		: option.displayName
}

export function providerAddressDisplayName(
	address: PluginNodeAddress | null,
	options: readonly PluginConsumerRequirementState['options'][number][],
): string {
	if (!address) return '未解析'
	const option = options.find(
		(candidate) => pluginNodeIndexKey(candidate.address) === pluginNodeIndexKey(address),
	)
	if (option) return providerOptionDisplayName(option)
	return address.variant === 'fork'
		? `${address.definition.exportName} / ${address.forkId}`
		: address.definition.exportName
}

export function isConsumerOverrideConfigurable(row: PluginConsumerRequirementState): boolean {
	return row.kind === 'abstract' || row.options.length > 1 || row.consumerOverride !== null
}

export function buildConsumerOverrideSelection(row: PluginConsumerRequirementState) {
	const optionEntries = row.options.map((option) => ({
		option,
		value: `${PROVIDER_VALUE_PREFIX}${pluginNodeIndexKey(option.address)}`,
	}))
	const optionsByValue = new Map(optionEntries.map(({ option, value }) => [value, option]))
	const overrideValue = row.consumerOverride
		? `${PROVIDER_VALUE_PREFIX}${pluginNodeIndexKey(row.consumerOverride)}`
		: FOLLOW_DEFAULT_VALUE
	const unavailableOverride =
		row.consumerOverride && !optionsByValue.has(overrideValue)
			? {
					value: overrideValue,
					label: `${providerAddressDisplayName(row.consumerOverride, row.options)}（当前不可选）`,
					disabled: true,
				}
			: null
	const inheritedProviderLabel = providerAddressDisplayName(row.inheritedProvider, row.options)
	return Object.freeze({
		data: Object.freeze([
			{
				value: FOLLOW_DEFAULT_VALUE,
				label: row.inheritedProvider ? `跟随默认 · ${inheritedProviderLabel}` : '跟随默认解析',
				disabled: false,
			},
			...optionEntries.map(({ option, value }) => ({
				value,
				label:
					option.availability === 'available'
						? providerOptionDisplayName(option)
						: `${providerOptionDisplayName(option)}（当前不可用）`,
				disabled: option.availability === 'unavailable',
			})),
			...(unavailableOverride ? [unavailableOverride] : []),
		]),
		value: overrideValue,
		providerFor(value: string): PluginNodeAddress | null | undefined {
			if (value === FOLLOW_DEFAULT_VALUE) return null
			if (value === overrideValue && row.consumerOverride) return row.consumerOverride
			return optionsByValue.get(value)?.address
		},
	})
}

type ConsumerRequirementsSnapshot = Readonly<{
	ownerKey: string
	items: readonly PluginConsumerRequirementState[]
}>

export function usePluginDependencyControls() {
	const { owner, refetch } = usePluginScope()
	const management = useRuntimeManagementClient()
	const ownerKey = pluginNodeIndexKey(owner)
	const [snapshot, setSnapshot] = useState<ConsumerRequirementsSnapshot | null>(null)
	const [loadingOwner, setLoadingOwner] = useState<string | null>(null)
	const [errorByOwner, setErrorByOwner] = useState<Readonly<{
		ownerKey: string
		error: string
	}> | null>(null)
	const [pendingKeys, setPendingKeys] = useState(() => new Set<string>())
	const requestIdRef = useRef(0)
	const pendingKeysRef = useRef(new Set<string>())
	const mountedRef = useRef(false)

	useEffect(() => {
		mountedRef.current = true
		return () => {
			mountedRef.current = false
		}
	}, [])

	const load = useCallback(async () => {
		const requestId = ++requestIdRef.current
		setLoadingOwner(ownerKey)
		try {
			const result = await management.dependencies.inspectConsumerRequirements(owner)
			if (result.ok === false) throw new Error(result.error)
			if (!mountedRef.current || requestIdRef.current !== requestId) return
			setSnapshot(Object.freeze({ ownerKey, items: result.items }))
			setErrorByOwner(null)
		} catch (error) {
			if (!mountedRef.current || requestIdRef.current !== requestId) return
			setErrorByOwner({ ownerKey, error: runtimeErrorMessage(error, '无法读取依赖实现') })
		} finally {
			if (mountedRef.current && requestIdRef.current === requestId) setLoadingOwner(null)
		}
	}, [management.dependencies, owner, ownerKey])

	useEffect(() => {
		void load()
	}, [load])

	const refreshAll = useCallback(async () => {
		await Promise.all([load(), refetch()])
	}, [load, refetch])

	const runPending = useCallback(
		async <T>(key: string, operation: () => Promise<T>): Promise<T> => {
			if (pendingKeysRef.current.has(key)) throw new Error('该依赖操作正在执行')
			pendingKeysRef.current.add(key)
			setPendingKeys(new Set(pendingKeysRef.current))
			try {
				return await operation()
			} finally {
				pendingKeysRef.current.delete(key)
				if (mountedRef.current) setPendingKeys(new Set(pendingKeysRef.current))
			}
		},
		[],
	)

	const setConsumerOverride = useCallback(
		async (requirement: PluginDefinitionAddress, provider: PluginNodeAddress | null) =>
			await runPending(
				`${ownerKey}:consumer-override:${pluginDefinitionIndexKey(requirement)}`,
				async () => {
					try {
						const result = await management.dependencies.setConsumerOverride({
							consumer: owner,
							requirement,
							provider,
						})
						if (result.ok || ('state' in result && result.state === 'unknown')) await refreshAll()
						return result
					} catch (error) {
						await refreshAll()
						throw error
					}
				},
			),
		[management.dependencies, owner, ownerKey, refreshAll, runPending],
	)

	const createFork = useCallback(
		async (base: PluginNodeAddress, forkId: string, requirement: PluginDefinitionAddress) =>
			await runPending(
				`${ownerKey}:fork-create:${pluginDefinitionIndexKey(requirement)}`,
				async () => {
					try {
						const result = await management.forks.ensure({
							base,
							forkId,
							autoStart: false,
							selectFor: { consumer: owner, requirement },
						})
						if (result.ok || ('state' in result && result.state === 'unknown')) await refreshAll()
						return result
					} catch (error) {
						await refreshAll()
						throw error
					}
				},
			),
		[management.forks, owner, ownerKey, refreshAll, runPending],
	)

	const removeFork = useCallback(
		async (fork: Extract<PluginNodeAddress, { variant: 'fork' }>) =>
			await runPending(`${ownerKey}:fork-remove:${pluginNodeIndexKey(fork)}`, async () => {
				try {
					const result = await management.forks.remove({
						base: { definition: fork.definition, variant: 'default' },
						forkId: fork.forkId,
					})
					if (result.ok || ('code' in result && result.code === 'persistence_failed')) {
						await refreshAll()
					}
					return result
				} catch (error) {
					await refreshAll()
					throw error
				}
			}),
		[management.forks, ownerKey, refreshAll, runPending],
	)

	const requirements = snapshot?.ownerKey === ownerKey ? snapshot.items : null
	const byRequirement = useMemo(
		() =>
			new Map(
				(requirements ?? []).map(
					(requirement) =>
						[pluginDefinitionIndexKey(requirement.requirement), requirement] as const,
				),
			),
		[requirements],
	)

	return {
		requirements,
		byRequirement,
		isLoading: loadingOwner === ownerKey,
		error: errorByOwner?.ownerKey === ownerKey ? errorByOwner.error : undefined,
		refresh: refreshAll,
		isConsumerOverridePending(requirement: PluginDefinitionAddress): boolean {
			return pendingKeys.has(
				`${ownerKey}:consumer-override:${pluginDefinitionIndexKey(requirement)}`,
			)
		},
		isCreateForkPending(requirement: PluginDefinitionAddress): boolean {
			return pendingKeys.has(`${ownerKey}:fork-create:${pluginDefinitionIndexKey(requirement)}`)
		},
		isRemoveForkPending(fork: PluginNodeAddress): boolean {
			return pendingKeys.has(`${ownerKey}:fork-remove:${pluginNodeIndexKey(fork)}`)
		},
		setConsumerOverride,
		createFork,
		removeFork,
	}
}
