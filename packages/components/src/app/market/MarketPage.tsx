import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
	Anchor,
	Badge,
	Box,
	Button,
	Group,
	Modal,
	List,
	ScrollArea,
	Stack,
	Text,
	useComputedColorScheme,
} from '@mantine/core'
import { openConfirmModal } from '@mantine/modals'
import { IconInfoCircle, IconExternalLink } from '@tabler/icons-react'
import {
	SnapshotDashboard,
	createMarketRpcClient,
	createSnapshotLoader,
	type InstallCandidate,
	type SnapshotResponse,
	type SnapshotLoader,
} from '@pluxel/market'
import { useMutation as useGqtyMutation, useQuery, type InstallPackageSpecInput } from '../gqty'
import { MARKET_BASE_URL } from '../constants'
import { useNotify } from '../notifications/useNotify'

function buildInstalledPackages(statuses: Array<any> | undefined) {
	const result: Record<string, string> = {}
	if (!statuses) return result
	for (const entry of statuses) {
		const source = entry?.source
		if (!source) continue
		if (source.kind !== 'package') continue
		const name = source.packageName || entry?.name
		if (!name) continue
		result[name] = source.version || ''
	}
	return result
}

function summarizeList(items: string[], peekCount: number, suffix: string, delimiter = '、') {
	if (!items.length) return ''
	if (items.length <= peekCount) {
		return items.join(delimiter)
	}
	return `${items.slice(0, peekCount).join(delimiter)} 等 ${items.length}${suffix}`
}

const formatCandidateLabel = (candidate: InstallCandidate) =>
	`${candidate.plugin.name}@${candidate.version}`

const parseDependencySpec = (spec: string) => {
	const trimmed = spec.trim()
	const match = trimmed.match(/^(@[^/@]+\/[^@]+|[^@]+)(?:@(.+))?$/)
	return {
		name: match?.[1] ?? trimmed,
		version: match?.[2],
		raw: trimmed,
	}
}

const getPackageNameFromSpec = (spec: string) => {
	const parsed = parseDependencySpec(spec)
	return parsed.name
}

const resolveLogColor = (level: unknown): 'blue' | 'yellow' | 'red' => {
	if (typeof level === 'number') {
		if (level >= 50) return 'red'
		if (level >= 40) return 'yellow'
		return 'blue'
	}
	if (typeof level === 'string') {
		const lowered = level.toLowerCase()
		if (lowered.includes('error') || lowered.includes('fatal')) return 'red'
		if (lowered.includes('warn')) return 'yellow'
	}
	return 'blue'
}

export function MarketPage() {
	const notify = useNotify()
	const scheme = useComputedColorScheme('light', { getInitialValueInEffect: true })
	const appearance = scheme === 'dark' ? 'dark' : 'light'
	const marketBase = MARKET_BASE_URL
	const lastNotifiedError = useRef<string | null>(null)
	const [cachedSnapshot, setCachedSnapshot] = useState<SnapshotResponse | null>(() => {
		if (typeof window === 'undefined') return null
		try {
			const raw = localStorage.getItem('pluxel:market:snapshot')
			if (!raw) return null
			return JSON.parse(raw) as SnapshotResponse
		} catch {
			return null
		}
	})
	const [installModalOpen, setInstallModalOpen] = useState(false)
	const [installLogs, setInstallLogs] = useState<
		Array<{ label: string; kind: 'primary' | 'dependency'; status: 'pending' | 'running' | 'success' | 'error'; message?: string }>
	>([])

	const marketClient = useMemo(
		() =>
			createMarketRpcClient({
				baseUrl: marketBase,
			}),
		[marketBase],
	)

	const query = useQuery({
		suspense: false,
		operationName: 'MarketInstalledPackages',
		notifyOnNetworkStatusChange: true,
		refetchOnReconnect: true,
		refetchOnWindowVisible: false,
		fetchInBackground: true,
		prepare: ({ query }) => {
			const overview = query.pluginStatus
			overview.summary.running
			overview.statuses.forEach((status) => {
				status.name
				status.source.kind
				status.source.packageName
				status.source.version
			})
		},
	})

	const snapshotLoader = useMemo<SnapshotLoader>(() => {
		const loadSnapshot = createSnapshotLoader(marketClient)
		return async () => {
			try {
				const data = await loadSnapshot()
				lastNotifiedError.current = null
				if (typeof window !== 'undefined') {
					try {
						localStorage.setItem('pluxel:market:snapshot', JSON.stringify(data))
						setCachedSnapshot(data)
					} catch {
						// ignore cache write errors
					}
				}
				return data
			} catch (error: any) {
				const message = error?.message ?? '无法获取市场快照'
				if (lastNotifiedError.current !== message) {
					lastNotifiedError.current = message
					notify({
						title: '市场数据请求失败',
						message,
						color: 'red',
					})
				}
				throw error
			}
		}
	}, [marketClient, notify])

	const installed = useMemo(
		() => buildInstalledPackages(query.pluginStatus?.statuses),
		[query.pluginStatus?.statuses],
	)

	useEffect(() => {
		if (typeof window === 'undefined') return
		const source = new EventSource('/logs/stream?name=package-manager')
		const connectedAt = Date.now()

		source.onmessage = (event) => {
			try {
				const payload = JSON.parse(event.data) as {
					msg?: string
					event?: string
					level?: number | string
					target?: string
					package?: string
					time?: string
				}
				const eventTime = payload.time ? Date.parse(payload.time) : Date.now()
				if (Number.isFinite(eventTime) && eventTime + 1500 < connectedAt) {
					// 忽略历史日志，避免初次连接时弹窗过多。
					return
				}
				const summary =
					payload.msg ||
					payload.event ||
					(payload.package || payload.target
						? `包管理事件：${payload.package ?? payload.target}`
						: '包管理事件')
				notify({
					title: '包管理日志',
					message: summary,
					color: resolveLogColor(payload.level),
					autoClose: 4000,
				})
			} catch {
				// ignore malformed message
			}
		}
		source.onerror = () => {
			source.close()
		}

		return () => {
			source.close()
		}
	}, [notify])

	const [installPackagesMutation] = useGqtyMutation(
		(
			mutation,
			variables: { specs: InstallPackageSpecInput[]; force?: boolean | null },
		) => {
			const result = mutation.installPackages({
				specs: variables.specs,
				force: variables.force ?? null,
			})
			result.ok
			result.error
			result.results.forEach((entry) => {
				entry.ok
				entry.code
				entry.error
				entry.installStatus
				entry.spec?.name
				entry.spec?.version
			})
			return result
		},
		{ suspense: false },
	)

	const handleInstallSubmit = useCallback(
		async (items: InstallCandidate[]) => {
			if (!items.length) {
				notify({
					title: '请选择插件',
					message: '请在市场列表中勾选一个或多个插件后再提交安装。',
					color: 'yellow',
				})
				return
			}

			type InstallTask = {
				label: string
				spec: InstallPackageSpecInput
				kind: 'primary' | 'dependency'
				from?: string
				force?: boolean
			}

			const missingRequiredDeps: InstallTask[] = []
			const optionalDeps: string[] = []
			const installedNames = installed
			const seenDependencyKeys = new Set<string>()

			for (const candidate of items) {
				const pluginDeps = candidate.plugin?.dependencies ?? []
				const optDeps = candidate.plugin?.optionalDependencies ?? []
				const pluginLabel = formatCandidateLabel(candidate)

				for (const depSpec of pluginDeps) {
					const parsed = parseDependencySpec(depSpec)
					const installedVersion = installedNames[parsed.name]
					const hasInstalled = installedVersion !== undefined
					const needsVersionUpdate =
						Boolean(parsed.version) &&
						(!installedVersion || installedVersion === '' || installedVersion !== parsed.version)
					if (hasInstalled && !needsVersionUpdate) {
						continue
					}
					const taskKey = parsed.raw
					if (seenDependencyKeys.has(taskKey)) continue
					seenDependencyKeys.add(taskKey)
					missingRequiredDeps.push({
						label: parsed.raw,
						spec: { raw: parsed.raw },
						kind: 'dependency',
						from: pluginLabel,
						force: hasInstalled ? needsVersionUpdate || undefined : undefined,
					})
				}

				for (const depSpec of optDeps) {
					const name = getPackageNameFromSpec(depSpec)
					if (installedNames[name]) continue
					optionalDeps.push(depSpec)
				}
			}

			if (missingRequiredDeps.length) {
				const confirmed = await new Promise<boolean>((resolve) => {
					openConfirmModal({
						title: '检测到插件依赖',
						children: (
							<Stack gap="xs">
								<Text size="sm">
									以下依赖尚未安装，将在提交的插件之前自动安装。若取消，本次安装会被终止。
								</Text>
								<List size="sm" spacing="xs">
									{missingRequiredDeps.map((dep) => (
										<List.Item key={dep.label}>
											<Group gap={6}>
												<Text fw={600}>{dep.label}</Text>
												{dep.from ? (
													<Text size="xs" c="dimmed">
														来源：{dep.from}
													</Text>
												) : null}
											</Group>
										</List.Item>
									))}
								</List>
								{optionalDeps.length ? (
									<Text size="xs" c="dimmed">
										可选依赖未自动安装：{summarizeList(optionalDeps, 4, ' 项')}
									</Text>
								) : null}
							</Stack>
						),
						labels: { confirm: '连带安装', cancel: '取消' },
						confirmProps: { color: 'blue' },
						onCancel: () => resolve(false),
						onConfirm: () => resolve(true),
					})
				})

				if (!confirmed) {
					notify({
						title: '已取消安装',
						message: '需要先安装依赖后再提交插件安装任务。',
						color: 'yellow',
					})
					return
				}
			}

			const installQueue: InstallTask[] = []
			const seenQueueKeys = new Set<string>()
			const enqueue = (task: InstallTask) => {
				const key =
					task.spec.raw ??
					`${task.spec.name ?? ''}@${task.spec.version ?? task.spec.tag ?? ''}`.toLowerCase()
				if (seenQueueKeys.has(key)) return
				seenQueueKeys.add(key)
				installQueue.push(task)
			}

			missingRequiredDeps.forEach((dep) => enqueue(dep))

			items.forEach((candidate) => {
				enqueue({
					label: formatCandidateLabel(candidate),
					spec: { name: candidate.plugin.name, version: candidate.version },
					kind: 'primary',
				})
			})

			setInstallModalOpen(true)
			setInstallLogs(
				installQueue.map((task) => ({
					label: task.label,
					kind: task.kind,
					status: 'pending',
				})),
			)

			const successes: string[] = []
			const failures: string[] = []

			setInstallLogs((prev) => prev.map((log) => ({ ...log, status: 'running' })))

			const specKey = (spec?: InstallPackageSpecInput) =>
				(spec?.raw || `${spec?.name ?? ''}@${spec?.version ?? spec?.tag ?? ''}` || '').toLowerCase()

			try {
				const res = await installPackagesMutation({
					args: {
						specs: installQueue.map((task) => task.spec),
						force: installQueue.some((task) => task.force) ? true : null,
					},
				})

				if (!res) {
					throw new Error('安装接口无返回结果')
				}

				if (!res.ok && res.error) {
					throw new Error(res.error)
				}

				const resultsByKey = new Map(
					res.results.map((entry) => {
						const key = entry.spec
							? specKey({
									raw: entry.spec.raw ?? undefined,
									name: entry.spec.name,
									version: entry.spec.version ?? undefined,
									tag: entry.spec.tag ?? undefined,
								})
							: ''
						return [key, entry]
					}),
				)

				setInstallLogs((prev) =>
					prev.map((log) => {
						const task = installQueue.find((t) => t.label === log.label)
						const entryKey = task ? specKey(task.spec) : ''
						const entry = resultsByKey.get(entryKey)
						if (!entry)
							return {
								...log,
								status: res.ok ? 'success' : 'error',
								message: res.error ?? '未知错误',
							}
						return entry.ok
							? { ...log, status: 'success' }
							: { ...log, status: 'error', message: entry.error ?? entry.code ?? '未知错误' }
					}),
				)

				res.results.forEach((entry) => {
					const label =
						entry.spec?.name && entry.spec?.version
							? `${entry.spec.name}@${entry.spec.version}`
							: entry.spec?.raw ?? entry.spec?.name ?? '未知包'
					if (entry.ok) successes.push(label)
					else failures.push(`${label}: ${entry.error ?? entry.code ?? '未知错误'}`)
				})
			} catch (error: any) {
				const message = error?.message ?? '网络错误'
				setInstallLogs((prev) =>
					prev.map((log) => ({ ...log, status: 'error', message })),
				)
				failures.push(message)
			}

			if (successes.length) {
				notify({
					title: '安装任务已提交',
					message: summarizeList(successes, 3, ' 项'),
					color: 'green',
				})
			}
			if (failures.length) {
				notify({
					title: '部分插件安装失败',
					message: summarizeList(failures, 2, ' 项', '；'),
					color: 'red',
				})
			}

			if (installQueue.length) {
				await query.$refetch(true)
			}
		},
		[installPackageMutation, installed, notify, query.$refetch],
	)

	return (
		<Stack
			gap="sm"
			style={{
				flex: 1,
				minHeight: 0,
				height: '100%',
				width: '100%',
			}}
		>
			<Group justify="space-between" align="center" gap="xs" wrap="wrap">
				<Group gap={6}>
					<Badge color="blue" size="sm" leftSection={<IconInfoCircle size={12} />}>
						市场
					</Badge>
					<Text size="sm" fw={600}>
						插件快照
					</Text>
				</Group>
				<Group gap={6}>
					<Text size="xs" c="dimmed">
						源：
						<Anchor href={marketBase} target="_blank" rel="noreferrer">
							{marketBase}
						</Anchor>
					</Text>
					<Button
						component="a"
						href={marketBase}
						target="_blank"
						rel="noreferrer"
						variant="subtle"
						size="compact-sm"
						leftSection={<IconExternalLink size={14} />}
					>
						打开服务
					</Button>
				</Group>
			</Group>

			<Box style={{ flex: 1, minHeight: 0, width: '100%', overflow: 'hidden' }}>
				<SnapshotDashboard
					appearance={appearance}
					locale="zh-CN"
					client={marketClient}
					snapshotSource={snapshotLoader}
					initialSnapshot={cachedSnapshot}
					enableInstallQueue
					onInstallSubmit={handleInstallSubmit}
					installedPackages={installed}
					className="pluxel-market-dashboard"
					style={{
						height: '100%',
						width: '100%',
						maxWidth: 'none',
						flex: 1,
						alignSelf: 'stretch',
					}}
				/>
			</Box>

			<Modal
				opened={installModalOpen}
				onClose={() => setInstallModalOpen(false)}
				title="安装进度"
				centered
				size="lg"
			>
				<ScrollArea.Autosize mah={320}>
					<Stack gap="xs">
						{installLogs.map((log) => {
							const color =
								log.status === 'success'
									? 'green'
									: log.status === 'error'
										? 'red'
										: log.kind === 'dependency'
											? 'blue'
											: 'gray'
							const statusLabel =
								log.status === 'pending'
									? '待开始'
									: log.status === 'running'
										? '进行中'
										: log.status === 'success'
											? '完成'
											: '失败'
							return (
								<Group key={log.label} gap="sm" align="flex-start">
									<Badge color={color} variant="light">
										{log.kind === 'dependency' ? '依赖' : '插件'}
									</Badge>
									<Stack gap={2} style={{ flex: 1 }}>
										<Group justify="space-between">
											<Text fw={600}>{log.label}</Text>
											<Text size="xs" c="dimmed">
												{statusLabel}
											</Text>
										</Group>
										{log.message ? (
											<Text size="xs" c="red">
												{log.message}
											</Text>
										) : null}
									</Stack>
								</Group>
							)
						})}
						{!installLogs.length ? (
							<Text size="sm" c="dimmed">
								等待安装任务…
							</Text>
						) : null}
					</Stack>
				</ScrollArea.Autosize>
			</Modal>
		</Stack>
	)
}
