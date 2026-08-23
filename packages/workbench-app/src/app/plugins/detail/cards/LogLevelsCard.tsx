import { Badge, Button, Code, Group, ScrollArea, Select, Stack, Text, Title } from '@mantine/core'
import {
	formatPluginNodeReference,
	pluginNodeAddressEqual,
	pluginNodeIndexKey,
	type PluginNodeAddress,
} from '@pluxel/core'
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
	runtimeErrorMessage,
	useRuntimeManagementClient,
	type LogLevel,
	type RuntimePluginLogLevel,
	type VersionedPluginLogPolicySnapshot,
} from '../../../../runtime'

type Snapshot = VersionedPluginLogPolicySnapshot
type Mutation = Pick<Snapshot, 'revision' | 'persistence'>

const LEVELS: readonly LogLevel[] = ['trace', 'debug', 'info', 'warning', 'error', 'fatal'] as const
const LEVEL_SET = new Set<string>(LEVELS)

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
	const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
	const [loading, setLoading] = useState(false)
	const [saving, setSaving] = useState(false)
	const [error, setError] = useState<string | null>(null)

	const refresh = useCallback(async () => {
		setLoading(true)
		setError(null)
		try {
			const res = await management.logging.getPolicy()
			setSnapshot(res)
		} catch (e) {
			setError(runtimeErrorMessage(e))
		} finally {
			setLoading(false)
		}
	}, [management.logging])

	useEffect(() => {
		void refresh()
	}, [refresh])

	const currentDefault = snapshot?.defaultLevel ?? 'info'
	const currentPlugin = snapshot?.overrides.find((entry) =>
		pluginNodeAddressEqual(entry.owner, owner),
	)?.level

	const pluginSelectValue = currentPlugin === undefined ? '__inherit__' : currentPlugin
	const defaultSelectValue = currentDefault

	const setPluginLevel = useCallback(
		async (next: string | null) => {
			setSaving(true)
			setError(null)
			try {
				if (!snapshot) throw new Error('Plugin log policy is not loaded')
				let updated: Mutation
				if (next === '__inherit__') {
					updated = await management.logging.clearPluginLevel(snapshot.revision, owner)
				} else if (next === '__off__') {
					updated = await management.logging.setPluginLevel(snapshot.revision, owner, 'off')
				} else {
					if (!next || !isLogLevel(next)) throw new Error(`Invalid log level: ${String(next)}`)
					updated = await management.logging.setPluginLevel(snapshot.revision, owner, next)
				}
				setSnapshot((previous) => {
					if (!previous) return previous
					const overrides = previous.overrides.filter(
						(entry) => !pluginNodeAddressEqual(entry.owner, owner),
					)
					if (next !== '__inherit__') {
						overrides.push({ owner, level: next === '__off__' ? 'off' : (next as LogLevel) })
					}
					return { ...previous, ...updated, overrides }
				})
			} catch (e) {
				setError(runtimeErrorMessage(e))
			} finally {
				setSaving(false)
			}
		},
		[management.logging, owner, snapshot],
	)

	const deleteRule = useCallback(
		async (ruleOwner: PluginNodeAddress) => {
			setSaving(true)
			setError(null)
			try {
				if (!snapshot) throw new Error('Plugin log policy is not loaded')
				const updated = await management.logging.clearPluginLevel(snapshot.revision, ruleOwner)
				setSnapshot((previous) => {
					if (!previous) return previous
					const overrides = previous.overrides.filter(
						(entry) => !pluginNodeAddressEqual(entry.owner, ruleOwner),
					)
					return { ...previous, ...updated, overrides }
				})
			} catch (e) {
				setError(runtimeErrorMessage(e))
			} finally {
				setSaving(false)
			}
		},
		[management.logging, snapshot],
	)

	const setDefaultLevel = useCallback(
		async (next: string | null) => {
			setSaving(true)
			setError(null)
			try {
				if (!snapshot) throw new Error('Plugin log policy is not loaded')
				let updated: Mutation
				if (next === '__off__') {
					updated = await management.logging.setDefaultLevel(snapshot.revision, 'off')
				} else {
					if (!next || !isLogLevel(next)) throw new Error(`Invalid log level: ${String(next)}`)
					updated = await management.logging.setDefaultLevel(snapshot.revision, next)
				}
				setSnapshot((previous) =>
					previous
						? {
								...previous,
								...updated,
								defaultLevel: next === '__off__' ? 'off' : (next as LogLevel),
							}
						: previous,
				)
			} catch (e) {
				setError(runtimeErrorMessage(e))
			} finally {
				setSaving(false)
			}
		},
		[management.logging, snapshot],
	)

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

	const clearAll = useCallback(async () => {
		setSaving(true)
		setError(null)
		try {
			if (!snapshot) throw new Error('Plugin log policy is not loaded')
			const next = await management.logging.resetPolicy(snapshot.revision)
			setSnapshot(next)
		} catch (e) {
			setError(runtimeErrorMessage(e))
		} finally {
			setSaving(false)
		}
	}, [management.logging, snapshot])

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
						onClick={() => void refresh()}
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
