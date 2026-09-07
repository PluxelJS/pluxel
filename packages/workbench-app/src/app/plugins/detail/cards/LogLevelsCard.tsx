import { Badge, Button, Code, Group, ScrollArea, Select, Stack, Text, Title } from '@mantine/core'
import {
	formatPluginNodeReference,
	pluginNodeAddressEqual,
	pluginNodeIndexKey,
	type PluginNodeAddress,
} from '@pluxel/core'
import { useMemo } from 'react'
import { useIsMutating, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
	runtimeErrorMessage,
	useRuntimeManagementClient,
	type LogLevel,
	type RuntimePluginLogLevel,
	type VersionedPluginLogPolicySnapshot,
} from '../../../../runtime'
import { managementQueryKeys } from '../../../managementQuery'

type Snapshot = VersionedPluginLogPolicySnapshot
type Mutation = Pick<Snapshot, 'revision' | 'persistence'>
type PolicyCommand =
	| Readonly<{ kind: 'plugin'; owner: PluginNodeAddress; level: RuntimePluginLogLevel | null }>
	| Readonly<{ kind: 'default'; level: RuntimePluginLogLevel }>
	| Readonly<{ kind: 'reset' }>

const LEVELS: readonly LogLevel[] = ['trace', 'debug', 'info', 'warning', 'error', 'fatal'] as const
const LEVEL_SET = new Set<string>(LEVELS)
const LOG_POLICY_MUTATION_KEY = ['management', 'logging', 'update-policy'] as const

const LEVEL_OPTIONS: Array<{ value: LogLevel; label: string }> = [
	{ value: 'trace', label: 'trace' },
	{ value: 'debug', label: 'debug' },
	{ value: 'info', label: 'info' },
	{ value: 'warning', label: 'warn' },
	{ value: 'error', label: 'error' },
	{ value: 'fatal', label: 'fatal' },
] as const

function isLogLevel(value: string): value is LogLevel {
	return LEVEL_SET.has(value)
}

export function LogLevelsCard({
	owner,
	compact = false,
}: {
	owner: PluginNodeAddress
	compact?: boolean
}) {
	const management = useRuntimeManagementClient()
	const queryClient = useQueryClient()
	const policyQuery = useQuery({
		queryKey: managementQueryKeys.loggingPolicy(),
		queryFn: () => management.logging.getPolicy(),
	})
	const snapshot = policyQuery.data ?? null
	const policyMutation = useMutation({
		mutationKey: LOG_POLICY_MUTATION_KEY,
		// Every write consumes the shared revision. Serializing within this session
		// lets a queued write observe the cache committed by the preceding one.
		scope: { id: 'management:logging-policy' },
		mutationFn: async (command: PolicyCommand): Promise<Snapshot> => {
			const current = queryClient.getQueryData<Snapshot>(managementQueryKeys.loggingPolicy())
			if (!current) throw new Error('Plugin log policy is not loaded')
			if (command.kind === 'reset') return management.logging.resetPolicy(current.revision)
			let updated: Mutation
			if (command.kind === 'default') {
				updated = await management.logging.setDefaultLevel(current.revision, command.level)
				return { ...current, ...updated, defaultLevel: command.level }
			}
			updated = command.level
				? await management.logging.setPluginLevel(current.revision, command.owner, command.level)
				: await management.logging.clearPluginLevel(current.revision, command.owner)
			const overrides = current.overrides.filter(
				(entry) => !pluginNodeAddressEqual(entry.owner, command.owner),
			)
			if (command.level) overrides.push({ owner: command.owner, level: command.level })
			return { ...current, ...updated, overrides }
		},
		onSuccess: (next) => {
			queryClient.setQueryData(managementQueryKeys.loggingPolicy(), next)
		},
		onError: async () => {
			await queryClient.invalidateQueries({
				queryKey: managementQueryKeys.loggingPolicy(),
				exact: true,
				refetchType: 'all',
			})
		},
	})
	const loading = policyQuery.isFetching
	const saving = useIsMutating({ mutationKey: LOG_POLICY_MUTATION_KEY, exact: true }) > 0
	const errorCause = policyMutation.error ?? policyQuery.error
	const error = errorCause ? runtimeErrorMessage(errorCause) : null

	const currentDefault = snapshot?.defaultLevel ?? 'info'
	const currentPlugin = snapshot?.overrides.find((entry) =>
		pluginNodeAddressEqual(entry.owner, owner),
	)?.level

	const pluginSelectValue = currentPlugin === undefined ? '__inherit__' : currentPlugin
	const defaultSelectValue = currentDefault

	const setPluginLevel = (next: string | null) => {
		if (next === '__inherit__') {
			policyMutation.mutate({ kind: 'plugin', owner, level: null })
			return
		}
		if (next === '__off__') {
			policyMutation.mutate({ kind: 'plugin', owner, level: 'off' })
			return
		}
		if (!next || !isLogLevel(next)) return
		policyMutation.mutate({ kind: 'plugin', owner, level: next })
	}

	const deleteRule = (ruleOwner: PluginNodeAddress) => {
		policyMutation.mutate({ kind: 'plugin', owner: ruleOwner, level: null })
	}

	const setDefaultLevel = (next: string | null) => {
		if (next === '__off__') {
			policyMutation.mutate({ kind: 'default', level: 'off' })
			return
		}
		if (!next || !isLogLevel(next)) return
		policyMutation.mutate({ kind: 'default', level: next })
	}

	const overrides = useMemo(() => {
		const levels = snapshot?.overrides
		if (!levels) return []
		const out: Array<{
			owner: PluginNodeAddress
			label: string
			level: RuntimePluginLogLevel
		}> = levels.map((entry) => ({
			owner: entry.owner,
			label: formatPluginNodeReference(entry.owner),
			level: entry.level,
		}))
		out.sort((a, b) => a.label.localeCompare(b.label))
		return out
	}, [snapshot])

	const clearAll = () => policyMutation.mutate({ kind: 'reset' })

	return (
		<Stack gap={compact ? 'xs' : 'sm'} style={compact ? { minHeight: 0 } : undefined}>
			<Group gap="xs" justify="space-between" wrap="nowrap">
				{compact ? (
					<Text size="xs" c="dimmed">
						调整默认级别或当前插件覆盖，便于临时排查。
					</Text>
				) : (
					<Title order={5}>日志级别</Title>
				)}
				<Group gap="xs" wrap="nowrap">
					<Button
						size="xs"
						variant="default"
						loading={loading}
						disabled={saving}
						onClick={() => void policyQuery.refetch()}
					>
						刷新
					</Button>
					<Button
						size="xs"
						color="red"
						variant="light"
						disabled={saving}
						onClick={() => void clearAll()}
					>
						重置策略
					</Button>
				</Group>
			</Group>

			{compact ? null : (
				<Text size="sm" c="dimmed">
					per-plugin level 由 HMR 面板管理并持久化；不会为每个插件创建 category/logger config（只做
					插件节点地址查表过滤）。
				</Text>
			)}

			{error ? (
				<Text size="sm" c="red">
					{error}
				</Text>
			) : null}

			<Group align="flex-start" grow gap="sm" wrap="wrap">
				<Stack gap="xs">
					<Text size="sm" fw={600}>
						默认（所有插件）
					</Text>
					<Select
						size="sm"
						value={defaultSelectValue}
						disabled={saving}
						onChange={(v) => void setDefaultLevel(v)}
						data={[{ value: '__off__', label: '关闭 (off)' }, ...LEVEL_OPTIONS]}
					/>
				</Stack>

				<Stack gap="xs">
					<Group gap="xs" justify="space-between" wrap="nowrap">
						<Text size="sm" fw={600}>
							当前插件
						</Text>
						<Badge variant="light" color="gray">
							<Code>{formatPluginNodeReference(owner)}</Code>
						</Badge>
					</Group>
					<Select
						size="sm"
						value={pluginSelectValue}
						disabled={saving}
						onChange={(v) => void setPluginLevel(v)}
						data={[
							{ value: '__inherit__', label: '继承默认' },
							{ value: '__off__', label: '关闭 (off)' },
							...LEVEL_OPTIONS,
						]}
					/>
				</Stack>
			</Group>

			{overrides.length > 0 ? (
				<Stack gap="xs" style={compact ? { minHeight: 0 } : undefined}>
					<Group gap="xs" justify="space-between" wrap="nowrap">
						<Text size="sm" fw={600}>
							已有规则
						</Text>
						<Badge variant="light" color="gray">
							{overrides.length}
						</Badge>
					</Group>
					<ScrollArea
						h={compact ? 132 : 160}
						type="auto"
						scrollbarSize={10}
						offsetScrollbars
						style={compact ? { minHeight: 0 } : undefined}
					>
						<Stack gap={4} p={2}>
							{overrides.map((r) => (
								<Group
									key={pluginNodeIndexKey(r.owner)}
									gap="xs"
									justify="space-between"
									wrap="nowrap"
								>
									<Code
										style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
									>
										{r.label}
									</Code>
									<Group gap="xs" wrap="nowrap">
										<Badge variant="light" color={r.level === 'off' ? 'red' : 'blue'}>
											{String(r.level)}
										</Badge>
										<Button
											size="xs"
											variant="subtle"
											color="gray"
											disabled={saving}
											onClick={() => void deleteRule(r.owner)}
										>
											移除
										</Button>
									</Group>
								</Group>
							))}
						</Stack>
					</ScrollArea>
				</Stack>
			) : null}
		</Stack>
	)
}
