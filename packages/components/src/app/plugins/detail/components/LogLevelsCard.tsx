import { Badge, Button, Code, Group, ScrollArea, Select, Stack, Text, Title } from '@mantine/core'
import type { LogLevel, PluginLevelsSnapshot, PluginLogLevel } from '@pluxel/runtime/web'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { rpcErrorMessage, useHmrWebClient } from '../../../rpc'

type Snapshot = {
	levels: Record<string, PluginLogLevel>
}

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

export function LogLevelsCard({ pluginId }: { pluginId: string }) {
	const hmr = useHmrWebClient()
	const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
	const [loading, setLoading] = useState(false)
	const [saving, setSaving] = useState(false)
	const [error, setError] = useState<string | null>(null)

	const refresh = useCallback(async () => {
		setLoading(true)
		setError(null)
		try {
			const res: PluginLevelsSnapshot = await hmr.withRpc((rpc) => rpc.logging().getPluginLevels())
			setSnapshot({
				levels: res.levels ?? Object.create(null),
			})
		} catch (e) {
			setError(rpcErrorMessage(e))
		} finally {
			setLoading(false)
		}
	}, [hmr])

	useEffect(() => {
		void refresh()
	}, [refresh])

	const currentDefault = snapshot?.levels?.['*']
	const currentPlugin = snapshot?.levels?.[pluginId]

	const pluginSelectValue =
		currentPlugin === undefined ? '__inherit__' : currentPlugin === null ? '__off__' : currentPlugin
	const defaultSelectValue =
		currentDefault === undefined
			? '__inherit__'
			: currentDefault === null
				? '__off__'
				: currentDefault

	const setPluginLevel = useCallback(
		async (next: string | null) => {
			setSaving(true)
			setError(null)
			try {
				await hmr.withRpc(async (rpc) => {
					const api = rpc.logging()
					if (next === '__inherit__') return await api.deletePluginLevel(pluginId)
					if (next === '__off__') return await api.setPluginLevel(pluginId, null)
					if (!next || !isLogLevel(next)) throw new Error(`Invalid log level: ${String(next)}`)
					return await api.setPluginLevel(pluginId, next)
				})
				setSnapshot((prev) => {
					if (!prev) return prev
					const levels = { ...prev.levels }
					if (next === '__inherit__') delete levels[pluginId]
					else if (next === '__off__') levels[pluginId] = null
					else if (next && isLogLevel(next)) levels[pluginId] = next
					return { ...prev, levels }
				})
			} catch (e) {
				setError(rpcErrorMessage(e))
			} finally {
				setSaving(false)
			}
		},
		[hmr, pluginId],
	)

	const deleteRule = useCallback(
		async (id: string) => {
			setSaving(true)
			setError(null)
			try {
				await hmr.withRpc((rpc) => rpc.logging().deletePluginLevel(id))
				setSnapshot((prev) => {
					if (!prev) return prev
					const levels = { ...prev.levels }
					delete levels[id]
					return { ...prev, levels }
				})
			} catch (e) {
				setError(rpcErrorMessage(e))
			} finally {
				setSaving(false)
			}
		},
		[hmr],
	)

	const setDefaultLevel = useCallback(
		async (next: string | null) => {
			setSaving(true)
			setError(null)
			try {
				await hmr.withRpc(async (rpc) => {
					const api = rpc.logging()
					if (next === '__inherit__') return await api.deletePluginLevelDefault()
					if (next === '__off__') return await api.setPluginLevelDefault(null)
					if (!next || !isLogLevel(next)) throw new Error(`Invalid log level: ${String(next)}`)
					return await api.setPluginLevelDefault(next)
				})
				setSnapshot((prev) => {
					if (!prev) return prev
					const levels = { ...prev.levels }
					if (next === '__inherit__') delete levels['*']
					else if (next === '__off__') levels['*'] = null
					else if (next && isLogLevel(next)) levels['*'] = next
					return { ...prev, levels }
				})
			} catch (e) {
				setError(rpcErrorMessage(e))
			} finally {
				setSaving(false)
			}
		},
		[hmr],
	)

	const overrides = useMemo(() => {
		const levels = snapshot?.levels
		if (!levels) return []
		const out: Array<{ id: string; level: PluginLogLevel }> = []
		for (const id in levels) {
			if (!Object.hasOwn(levels, id)) continue
			if (id === '*') continue
			out.push({ id, level: levels[id] })
		}
		out.sort((a, b) => a.id.localeCompare(b.id))
		return out
	}, [snapshot])

	const clearAll = useCallback(async () => {
		setSaving(true)
		setError(null)
		try {
			await hmr.withRpc((rpc) => rpc.logging().clearPluginLevels())
			setSnapshot({ levels: Object.create(null) })
		} catch (e) {
			setError(rpcErrorMessage(e))
		} finally {
			setSaving(false)
		}
	}, [hmr])

	return (
		<Stack gap="sm">
			<Group gap="xs" justify="space-between" wrap="nowrap">
				<Title order={5}>日志级别</Title>
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
						清空规则
					</Button>
				</Group>
			</Group>

			<Text size="sm" c="dimmed">
				per-plugin level 由 HMR 面板管理并持久化；不会为每个插件创建 category/logger config（只做
				pluginId 查表过滤）。
			</Text>

			{error ? (
				<Text size="sm" c="red">
					{error}
				</Text>
			) : null}

			<Stack gap="xs">
				<Text size="sm" fw={600}>
					默认（所有插件）
				</Text>
				<Select
					size="sm"
					value={defaultSelectValue}
					disabled={saving}
					onChange={(v) => void setDefaultLevel(v)}
					data={[
						{ value: '__inherit__', label: '继承全局 (PLUXEL_LOG_LEVEL)' },
						{ value: '__off__', label: '关闭 (null)' },
						...LEVEL_OPTIONS,
					]}
				/>
			</Stack>

			<Stack gap="xs">
				<Group gap="xs" justify="space-between" wrap="nowrap">
					<Text size="sm" fw={600}>
						当前插件
					</Text>
					<Badge variant="light" color="gray">
						<Code>{pluginId}</Code>
					</Badge>
				</Group>
				<Select
					size="sm"
					value={pluginSelectValue}
					disabled={saving}
					onChange={(v) => void setPluginLevel(v)}
					data={[
						{ value: '__inherit__', label: '继承默认' },
						{ value: '__off__', label: '关闭 (null)' },
						...LEVEL_OPTIONS,
					]}
				/>
			</Stack>

			{overrides.length ? (
				<Stack gap="xs">
					<Group gap="xs" justify="space-between" wrap="nowrap">
						<Text size="sm" fw={600}>
							已有规则
						</Text>
						<Badge variant="light" color="gray">
							{overrides.length}
						</Badge>
					</Group>
					<ScrollArea h={160} type="auto" scrollbarSize={10} offsetScrollbars>
						<Stack gap={4} p={2}>
							{overrides.map((r) => (
								<Group key={r.id} gap="xs" justify="space-between" wrap="nowrap">
									<Code
										style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
									>
										{r.id}
									</Code>
									<Group gap="xs" wrap="nowrap">
										<Badge variant="light" color={r.level === null ? 'red' : 'blue'}>
											{String(r.level)}
										</Badge>
										<Button
											size="xs"
											variant="subtle"
											color="gray"
											disabled={saving}
											onClick={() => void deleteRule(r.id)}
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
