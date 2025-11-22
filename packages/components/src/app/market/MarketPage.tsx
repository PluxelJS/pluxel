import { useCallback, useMemo, useRef } from 'react'
import {
	Anchor,
	Badge,
	Box,
	Button,
	Group,
	Stack,
	Text,
	useComputedColorScheme,
} from '@mantine/core'
import { IconInfoCircle, IconExternalLink } from '@tabler/icons-react'
import {
	SnapshotDashboard,
	createMarketRpcClient,
	createSnapshotLoader,
	type InstallCandidate,
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

export function MarketPage() {
	const notify = useNotify()
	const scheme = useComputedColorScheme('light', { getInitialValueInEffect: true })
	const appearance = scheme === 'dark' ? 'dark' : 'light'
	const marketBase = MARKET_BASE_URL
	const lastNotifiedError = useRef<string | null>(null)

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

	const [installPackageMutation] = useGqtyMutation(
		(mutation, variables: { spec: InstallPackageSpecInput }) => {
			const result = mutation.installPackage({
				spec: variables.spec,
			})
			result.ok
			result.code
			result.error
			result.installStatus
			result.spec?.name
			result.spec?.version
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

			const installationResults = await Promise.all(
				items.map(async (candidate) => {
					const label = formatCandidateLabel(candidate)
					const spec: InstallPackageSpecInput = {
						name: candidate.plugin.name,
						version: candidate.version,
					}
					try {
						const res = await installPackageMutation({ args: { spec } })
						if (!res?.ok) {
							return {
								label,
								error: res?.error ?? res?.code ?? '未知错误',
							}
						}
						return { label }
					} catch (error: any) {
						return {
							label,
							error: error?.message ?? '网络错误',
						}
					}
				}),
			)

			const successes = installationResults
				.filter((result) => !result.error)
				.map((result) => result.label)
			const failures = installationResults
				.filter((result) => result.error)
				.map((result) => `${result.label}: ${result.error}`)

			if (successes.length) {
				notify({
					title: '安装任务已提交',
					message: summarizeList(successes, 3, ' 个插件'),
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

			await query.$refetch(true)
		},
		[installPackageMutation, notify, query.$refetch],
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
		</Stack>
	)
}
