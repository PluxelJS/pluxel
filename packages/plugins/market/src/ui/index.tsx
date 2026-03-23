// packages/plugins/market/src/ui/index.tsx

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
import {
	SnapshotDashboard,
	createMarketRpcClient,
	createSnapshotLoader,
	type InstallCandidate,
	type SnapshotLoader,
} from '@pluxel/market'
import {
	createPluginUiHelpers,
	definePluginUIModule,
	type PackageBatchResult,
	type PackageInventoryEntry,
	type PackageSpecInput,
} from '@pluxel/runtime/web/ui'
import { IconExternalLink, IconInfoCircle, IconShoppingBag } from '@tabler/icons-react'
import { useCallback, useEffect, useMemo, useState } from 'react'

declare global {
	interface Window {
		__PLUXEL_MARKET_BASE_URL__?: string
		PLUXEL_MARKET_BASE_URL?: string
	}
}

const DEFAULT_MARKET_BASE = 'https://market.pluxel.dev'

const formatCandidateLabel = (candidate: InstallCandidate) =>
	`${candidate.plugin.name}@${candidate.version}`

type InstallTask = {
	label: string
	spec: PackageSpecInput
	kind: 'primary' | 'dependency'
	from?: string
	force?: boolean
}

function resolveMarketBase() {
	if (typeof window !== 'undefined') {
		return (
			window.__PLUXEL_MARKET_BASE_URL__ ??
			window.PLUXEL_MARKET_BASE_URL ??
			(import.meta.env?.VITE_PLUXEL_MARKET_BASE_URL as string | undefined) ??
			DEFAULT_MARKET_BASE
		)
	}
	return (import.meta.env?.VITE_PLUXEL_MARKET_BASE_URL as string | undefined) ?? DEFAULT_MARKET_BASE
}

function summarizeList(items: string[], peekCount: number, suffix: string, delimiter = '、') {
	if (!items.length) return ''
	if (items.length <= peekCount) return items.join(delimiter)
	return `${items.slice(0, peekCount).join(delimiter)} 等 ${items.length}${suffix}`
}

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

const specKey = (spec?: PackageSpecInput) =>
	(spec?.raw || `${spec?.name ?? ''}@${spec?.version ?? spec?.tag ?? ''}` || '').toLowerCase()

async function fetchPackageInventory(
	hmr: ReturnType<typeof marketUi.usePluginRuntime>['hmr'],
	includeUntracked: boolean,
): Promise<PackageInventoryEntry[]> {
	return hmr.withRpc((rpc) => rpc.package().inventory({ includeUntracked }))
}

function buildInstalledPackages(inventory: PackageInventoryEntry[]): Record<string, string> {
	const result: Record<string, string> = {}
	for (const entry of inventory) {
		const spec = entry.spec
		const name = spec?.name
		if (!name) continue
		const installed = entry.installedVersion ?? spec?.version ?? ''
		result[name] = installed ?? ''
	}
	return result
}

function resolveMessage(error: unknown, fallback: string) {
	if (error instanceof Error) return error.message
	if (typeof error === 'string') return error
	return fallback
}

type UiNotifyLike = {
	title?: string
	message?: string
	tone?: string
}

type UiConfirmLike = {
	title?: string
	message?: string
	confirmLabel?: string
	cancelLabel?: string
}

const marketUi = createPluginUiHelpers('MarketUI')

function MarketPage() {
	const { hmr, notify, confirm } = marketUi.usePluginRuntime()
	const scheme = useComputedColorScheme('light', { getInitialValueInEffect: true })
	const appearance = scheme === 'dark' ? 'dark' : 'light'
	const marketBase = useMemo(() => resolveMarketBase(), [])
	const [inlineMessage, setInlineMessage] = useState<string | null>(null)
	const [installedPackages, setInstalledPackages] = useState<Record<string, string>>({})
	const [installing, setInstalling] = useState(false)

	const notifyUser = useCallback(
		(payload: UiNotifyLike) => {
			if (notify) {
				notify(payload)
				return
			}
			if (!payload.message) return
			const prefix = payload.title ? `[${payload.title}]` : '[market]'
			if (payload.tone === 'error') console.error(prefix, payload.message)
			else console.warn(prefix, payload.message)
		},
		[notify],
	)

	const confirmAction = useCallback(
		(payload: UiConfirmLike) => {
			if (confirm) return confirm(payload)
			const msg = [payload.title, payload.message].filter(Boolean).join('\n') || '确认继续？'
			return Promise.resolve(typeof window !== 'undefined' ? window.confirm(msg) : false)
		},
		[confirm],
	)

	const marketClient = useMemo(
		() =>
			createMarketRpcClient({
				baseUrl: marketBase,
			}),
		[marketBase],
	)

	const loadInventory = useCallback(async () => {
		try {
			const inventory = await fetchPackageInventory(hmr, false)
			setInstalledPackages(buildInstalledPackages(inventory))
		} catch (error) {
			notifyUser({
				title: '读取包清单失败',
				message: resolveMessage(error, '无法加载已安装包信息'),
				tone: 'error',
			})
		}
	}, [hmr, notifyUser])

	useEffect(() => {
		void loadInventory()
	}, [loadInventory])

	const snapshotLoader = useCallback<SnapshotLoader>(async () => {
		const loadSnapshot = createSnapshotLoader(marketClient)
		try {
			return await loadSnapshot()
		} catch (error) {
			const message = resolveMessage(error, '无法获取市场快照')
			notifyUser({
				title: '市场数据请求失败',
				message,
				tone: 'error',
			})
			throw error
		}
	}, [marketClient, notifyUser])

	const handleInstallSubmit = useCallback(
		async (items: InstallCandidate[]) => {
			if (installing) return
			setInlineMessage(null)
			if (!items.length) {
				setInlineMessage('请先在市场中勾选一个或多个插件后再提交安装。')
				return
			}

			const missingRequiredDeps: InstallTask[] = []
			const optionalDeps: string[] = []
			const seenDependencyKeys = new Set<string>()

			for (const candidate of items) {
				const pluginDeps = candidate.plugin?.dependencies ?? []
				const optDeps = candidate.plugin?.optionalDependencies ?? []
				const pluginLabel = formatCandidateLabel(candidate)

				for (const depSpec of pluginDeps) {
					const parsed = parseDependencySpec(depSpec)
					const installedVersion = installedPackages[parsed.name]
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
					if (installedPackages[name]) continue
					optionalDeps.push(depSpec)
				}
			}

			if (missingRequiredDeps.length) {
				const dependencyList = summarizeList(
					missingRequiredDeps.map((dep) => dep.label),
					4,
					' 项',
				)
				const optionalList = optionalDeps.length
					? `可选依赖未自动安装：${summarizeList(optionalDeps, 4, ' 项')}`
					: ''
				const confirmed = await confirmAction({
					title: '检测到插件依赖',
					message: [`以下依赖将自动安装：${dependencyList}`, optionalList]
						.filter(Boolean)
						.join('\n'),
					confirmLabel: '连带安装',
					cancelLabel: '取消',
				})

				if (!confirmed) {
					setInlineMessage('已取消安装：需要先安装依赖后再提交插件安装任务。')
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

			for (const dep of missingRequiredDeps) {
				enqueue(dep)
			}

			for (const candidate of items) {
				enqueue({
					label: formatCandidateLabel(candidate),
					spec: { name: candidate.plugin.name, version: candidate.version },
					kind: 'primary',
				})
			}

			setInstalling(true)
			const failures: string[] = []
			try {
				const res = await hmr.withRpc((rpc) =>
					rpc.package().mutate({
						action: 'install',
						specs: installQueue.map((task) => task.spec),
						options: { force: installQueue.some((task) => task.force) },
					}),
				)
				if (!res) {
					throw new Error('安装接口无返回结果')
				}

				if (res.ok === false && res.error) {
					throw new Error(res.error)
				}

				const resultsByKey = new Map(
					(res.results ?? []).map((entry: PackageBatchResult['results'][number]) => [
						specKey({
							raw: entry?.spec?.raw ?? undefined,
							name: entry?.spec?.name ?? undefined,
							version: entry?.spec?.version ?? undefined,
							tag: entry?.spec?.tag ?? undefined,
						}),
						entry,
					]),
				)

				for (const task of installQueue) {
					const key = specKey(task.spec)
					const entry = resultsByKey.get(key)
					if (!entry?.ok) {
						const label = task.label || task.spec.raw || task.spec.name || '未知包'
						failures.push(`${label}: ${entry?.error ?? entry?.code ?? '未知错误'}`)
					}
				}

				if (failures.length) {
					notifyUser({
						title: '部分插件安装失败',
						message: summarizeList(failures, 2, ' 项', '；'),
						tone: 'error',
					})
				} else {
					notifyUser({
						title: '安装已提交',
						message: `已提交 ${installQueue.length} 个安装任务。`,
						tone: 'success',
					})
				}
			} catch (error) {
				const message = resolveMessage(error, '网络错误')
				notifyUser({
					title: '安装失败',
					message,
					tone: 'error',
				})
			} finally {
				setInstalling(false)
				void loadInventory()
			}
		},
		[confirmAction, hmr, installing, installedPackages, loadInventory, notifyUser],
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

			{inlineMessage ? (
				<Text size="sm" c="yellow">
					{inlineMessage}
				</Text>
			) : null}

			<Box style={{ flex: 1, minHeight: 0, width: '100%', overflow: 'hidden' }}>
				<SnapshotDashboard
					appearance={appearance}
					locale="zh-CN"
					client={marketClient}
					snapshotSource={snapshotLoader}
					enableInstallQueue
					onInstallSubmit={handleInstallSubmit}
					installedPackages={installedPackages}
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

export default definePluginUIModule({
	routes: [
		{
			definition: {
				path: '/market',
				title: '市场',
				icon: <IconShoppingBag size={18} stroke={1.7} />,
				addToNav: true,
				navPriority: 40,
			},
			render: () => <MarketPage />,
		},
	],
})
