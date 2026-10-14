import { Badge, Button, Code, Group, Popover, ScrollArea, Select, Stack, Text } from '@mantine/core'
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
} from '../../runtime'
import { managementQueryKeys, refetchManagementQuery } from '../managementQuery'

type Mutation = Pick<VersionedPluginLogPolicySnapshot, 'revision' | 'persistence'>
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

export function LogPolicyPopover({ owner }: { owner: PluginNodeAddress }) {
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
		mutationFn: async (command: PolicyCommand): Promise<VersionedPluginLogPolicySnapshot> => {
			await queryClient.cancelQueries({
				queryKey: managementQueryKeys.loggingPolicy(),
				exact: true,
			})
			const current = queryClient.getQueryData<VersionedPluginLogPolicySnapshot>(
				managementQueryKeys.loggingPolicy(),
			)
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
		onSuccess: async (next) => {
			// A focus refresh may have started during the write. Fence its late cache commit too.
			await queryClient.cancelQueries({
				queryKey: managementQueryKeys.loggingPolicy(),
				exact: true,
			})
			queryClient.setQueryData(managementQueryKeys.loggingPolicy(), next)
		},
		onError: async () => {
			await refetchManagementQuery(queryClient, managementQueryKeys.loggingPolicy())
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

	const pluginSelectValue =
		currentPlugin === undefined
			? '__inherit__'
			: currentPlugin === 'off'
				? '__off__'
				: currentPlugin
	const defaultSelectValue = currentDefault === 'off' ? '__off__' : currentDefault

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

	const content = (
		<Stack gap="xs" style={{ minHeight: 0 }}>
			<Group gap="xs" justify="space-between">
				<Text size="xs" c="dimmed">
					当前插件可单独设置级别；默认级别影响所有继承它的插件。
				</Text>
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
						disabled={saving || !snapshot}
						onClick={() => void clearAll()}
					>
						重置全部策略
					</Button>
				</Group>
			</Group>

			{error ? (
				<Text size="sm" c="red">
					{error}
				</Text>
			) : null}

			<Stack gap="sm">
				<Stack gap="xs">
					<Text size="sm" fw={600}>
						默认（所有插件）
					</Text>
					<Select
						size="sm"
						aria-label="所有插件默认日志级别"
						value={defaultSelectValue}
						disabled={saving || !snapshot}
						onChange={(v) => void setDefaultLevel(v)}
						data={[{ value: '__off__', label: '关闭 (off)' }, ...LEVEL_OPTIONS]}
					/>
				</Stack>

				<Stack gap="xs">
					<Group gap="xs" justify="space-between" wrap="nowrap">
						<Text size="sm" fw={600}>
							当前插件
						</Text>
					</Group>
					<Select
						size="sm"
						aria-label="当前插件日志级别"
						value={pluginSelectValue}
						disabled={saving || !snapshot}
						onChange={(v) => void setPluginLevel(v)}
						data={[
							{ value: '__inherit__', label: '继承默认' },
							{ value: '__off__', label: '关闭 (off)' },
							...LEVEL_OPTIONS,
						]}
					/>
				</Stack>
			</Stack>

			{overrides.length > 0 ? (
				<Stack gap="xs" style={{ minHeight: 0 }}>
					<Group gap="xs" justify="space-between" wrap="nowrap">
						<Text size="sm" fw={600}>
							已有规则
						</Text>
						<Badge variant="light" color="gray">
							{overrides.length}
						</Badge>
					</Group>
					<ScrollArea
						h={132}
						type="auto"
						scrollbarSize={10}
						offsetScrollbars
						style={{ minHeight: 0 }}
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
											disabled={saving || !snapshot}
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
	const effectiveLevel = currentPlugin ?? currentDefault
	return (
		<Popover width={360} position="bottom-start" shadow="md" withinPortal>
			<Popover.Target>
				<Button
					size="compact-xs"
					variant="subtle"
					color={error ? 'red' : 'gray'}
					aria-label="日志策略"
					title="设置当前插件和默认日志级别"
				>
					{error
						? '日志策略读取失败'
						: !snapshot
							? '日志策略加载中…'
							: `日志级别 ${effectiveLevel}${currentPlugin === undefined ? ' · 默认' : ''}`}
				</Button>
			</Popover.Target>
			<Popover.Dropdown style={{ maxWidth: 'calc(100vw - 24px)' }}>
				<ScrollArea.Autosize mah="60dvh" type="auto">
					{content}
				</ScrollArea.Autosize>
			</Popover.Dropdown>
		</Popover>
	)
}
