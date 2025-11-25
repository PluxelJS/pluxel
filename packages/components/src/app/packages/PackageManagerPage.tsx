import {
	ActionIcon,
	Alert,
	Badge,
	Box,
	Button,
	Card,
	CardSection,
	Checkbox,
	Flex,
	Grid,
	Group,
	Loader,
	Menu,
	Paper,
	ScrollArea,
	Stack,
	Table,
	Text,
	Textarea,
	TextInput,
	Title,
} from '@mantine/core'
import { openConfirmModal } from '@mantine/modals'
import {
	IconAlertTriangle,
	IconDotsVertical,
	IconRefresh,
	IconRotateClockwise,
	IconSearch,
	IconTrash,
} from '@tabler/icons-react'
import type { FormEventHandler } from 'react'
import { useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react'
import type {
	InstallPackageSpecInput,
	PackageBatchMutationResult,
	PackageLoadIssue,
	PluginStatusEntry,
	UninstallPackageScopeInput,
} from '../gqty'
import { useMutation as useGqtyMutation, useQuery } from '../gqty'
import { RouterLinkAdapter } from '../RouterLinkAdapter'
import { useNotify } from '../notifications/useNotify'

type Maybe<T> = T | null | undefined

type PackageRow = {
	name: string
	version: string | null
	tag: string | null
	raw: string | null
	pluginCount: number
	runningCount: number
	pluginNames: string[]
	issues: PackageLoadIssue[]
}

const ISSUE_SOURCE_LABEL: Record<string, string> = {
	load: '加载',
	restore: '恢复',
}

const timeFormatter = new Intl.DateTimeFormat('zh-CN', {
	month: '2-digit',
	day: '2-digit',
	hour: '2-digit',
	minute: '2-digit',
	second: '2-digit',
})

function formatTimestamp(value?: number | null) {
	if (!value || Number.isNaN(value)) return '未知时间'
	try {
		return timeFormatter.format(new Date(value))
	} catch {
		return new Date(value).toLocaleString()
	}
}

function ensureRow(map: Map<string, PackageRow>, name: string, raw?: string | null) {
	let row = map.get(name)
	if (!row) {
		row = {
			name,
			version: null,
			tag: null,
			raw: raw ?? null,
			pluginCount: 0,
			runningCount: 0,
			pluginNames: [],
			issues: [],
		}
		map.set(name, row)
	} else if (raw && !row.raw) {
		row.raw = raw
	}
	return row
}

function buildPackageRows(
	statuses: Array<Maybe<PluginStatusEntry>>,
	issues: Array<Maybe<PackageLoadIssue>>,
): PackageRow[] {
	const map = new Map<string, PackageRow>()
	for (const entry of statuses ?? []) {
		const source = entry?.source
		if (!source || source.kind !== 'package') continue
		const pkgName = source.packageName || ''
		if (!pkgName) continue
		const row = ensureRow(map, pkgName, source.packageName)
		if (source.version && !row.version) row.version = source.version
		if (source.tag && !row.tag) row.tag = source.tag
		if (entry?.isRunning) row.runningCount += 1
		row.pluginCount += 1
		const pluginName = entry?.name
		if (pluginName && !row.pluginNames.includes(pluginName)) {
			row.pluginNames.push(pluginName)
		}
	}

	for (const issue of issues ?? []) {
		const spec = issue?.spec
		if (!spec?.name) continue
		const row = ensureRow(map, spec.name, spec.raw ?? spec.name)
		if (!row.version && spec.version) row.version = spec.version
		if (!row.tag && spec.tag) row.tag = spec.tag
		row.issues.push(issue)
	}

	return Array.from(map.values()).sort((a, b) =>
		a.name.localeCompare(b.name, 'zh-CN', { sensitivity: 'base' }),
	)
}

function toSpecInput(row: PackageRow): InstallPackageSpecInput {
	if (row.version) {
		return { name: row.name, version: row.version }
	}
	if (row.tag) {
		return { name: row.name, tag: row.tag }
	}
	if (row.raw) {
		return { raw: row.raw }
	}
	return { name: row.name }
}

function formatSpec(row: PackageRow) {
	if (row.version) return `v${row.version}`
	if (row.tag) return `tag: ${row.tag}`
	return 'latest'
}

const INSTALL_DELIMITER = /[\n,;]+/

function parseInstallSpecs(input: string): string[] {
	return input
		.split(INSTALL_DELIMITER)
		.map((item) => item.trim())
		.filter((item, index, array) => item.length > 0 && array.indexOf(item) === index)
}

export function PackageManagerPage() {
	const query = useQuery({
		suspense: false,
		operationName: 'PackageManagerPage',
		notifyOnNetworkStatusChange: true,
		refetchOnReconnect: true,
		refetchOnWindowVisible: false,
		fetchInBackground: true,
		prepare: ({ query }) => {
			const overview = query.pluginStatus
			const summary = overview.summary
			summary.total
			summary.running
			overview.statuses.forEach((status) => {
				status.name
				status.isRunning
				const source = status.source
				source.kind
				source.packageName
				source.version
				source.tag
			})
			query.packageLoadIssues.forEach((issue) => {
				issue.message
				issue.recordedAt
				issue.source
				issue.spec.name
				issue.spec.raw
				issue.spec.version
				issue.spec.tag
				issue.spec.target
				issue.error
			})
		},
	})

	const [installInput, setInstallInput] = useState('')
	const [forceInstall, setForceInstall] = useState(false)
	const notify = useNotify()
	const pendingInstallSpecs = useMemo(() => parseInstallSpecs(installInput), [installInput])

	const statuses = useMemo(() => {
		try {
			return [...(query.pluginStatus?.statuses ?? [])]
		} catch (error) {
			console.error('[PackageManager] failed to read plugin statuses', error)
			return []
		}
	}, [query.pluginStatus?.statuses])

	const loadIssues = useMemo(() => {
		try {
			return [...(query.packageLoadIssues ?? [])]
		} catch (error) {
			console.error('[PackageManager] failed to read load issues', error)
			return []
		}
	}, [query.packageLoadIssues])

	const rows = useMemo(() => buildPackageRows(statuses, loadIssues), [statuses, loadIssues])
	const totalPackages = rows.length
	const runningPackages = rows.filter((row) => row.runningCount > 0).length
	const packagesWithIssues = rows.filter((row) => row.issues.length > 0).length
	const packageConsumers = useMemo(
		() => statuses.filter((entry) => entry?.source?.kind === 'package').length,
		[statuses],
	)
	const summaryStats = [
		{ label: '包总数', value: totalPackages },
		{ label: '被引用插件', value: packageConsumers },
		{ label: '运行中的包', value: runningPackages },
		{ label: '存在告警', value: packagesWithIssues, color: packagesWithIssues ? 'red' : undefined },
	]
	const [packageSearch, setPackageSearch] = useState('')
	const deferredPackageSearch = useDeferredValue(packageSearch.trim().toLowerCase())
	const searchActive = deferredPackageSearch.length > 0
	const filteredRows = useMemo(() => {
		if (!deferredPackageSearch) return rows
		return rows.filter((row) => {
			const term = deferredPackageSearch
			if (row.name.toLowerCase().includes(term)) return true
			if (row.pluginNames.some((plugin) => plugin.toLowerCase().includes(term))) return true
			if ((row.version ?? '').toLowerCase().includes(term)) return true
			if ((row.tag ?? '').toLowerCase().includes(term)) return true
			return false
		})
	}, [rows, deferredPackageSearch])

	const [selectedPackages, setSelectedPackages] = useState<Set<string>>(new Set())
	const selectedRows = useMemo(
		() => rows.filter((row) => selectedPackages.has(row.name)),
		[rows, selectedPackages],
	)
	const selectedVisibleCount = useMemo(
		() => filteredRows.filter((row) => selectedPackages.has(row.name)).length,
		[filteredRows, selectedPackages],
	)

	useEffect(() => {
		setSelectedPackages((prev) => {
			const rowNames = new Set(rows.map((row) => row.name))
			let changed = false
			const next = new Set<string>()
			for (const name of prev) {
				if (rowNames.has(name)) {
					next.add(name)
				} else {
					changed = true
				}
			}
			if (!changed && next.size === prev.size) {
				return prev
			}
			return next
		})
	}, [rows])

	const setRowSelected = useCallback((name: string, checked: boolean) => {
		setSelectedPackages((prev) => {
			const next = new Set(prev)
			if (checked) next.add(name)
			else next.delete(name)
			return next
		})
	}, [])

	const toggleSelectAllVisible = useCallback(
		(checked: boolean) => {
			setSelectedPackages((prev) => {
				const next = new Set(prev)
				if (checked) {
					filteredRows.forEach((row) => next.add(row.name))
				} else {
					filteredRows.forEach((row) => next.delete(row.name))
				}
				return next
			})
		},
		[filteredRows],
	)

	const clearSelection = useCallback(() => setSelectedPackages(new Set()), [])

	const [installPackageMutation, installState] = useGqtyMutation(
		(mutation, variables: { spec: InstallPackageSpecInput; force?: boolean }) => {
			const result = mutation.installPackage({
				spec: variables.spec,
				force: variables.force || null,
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

	const [reinstallPackageMutation, reinstallState] = useGqtyMutation(
		(mutation, variables: { spec: InstallPackageSpecInput; scope: UninstallPackageScopeInput }) => {
			const result = mutation.reinstallPackage({
				spec: variables.spec,
				force: true,
				scope: variables.scope,
			})
			result.ok
			result.code
			result.error
			result.installStatus
			return result
		},
		{ suspense: false },
	)

	const [uninstallPackageMutation, uninstallState] = useGqtyMutation(
		(mutation, variables: { spec: InstallPackageSpecInput; scope: UninstallPackageScopeInput }) => {
			const result = mutation.uninstallPackage({
				spec: variables.spec,
				scope: variables.scope,
			})
			result.ok
			result.code
			result.error
			return result
		},
		{ suspense: false },
	)

	const [reloadPackagesMutation, reloadBatchState] = useGqtyMutation(
		(mutation, variables: { specs: InstallPackageSpecInput[]; fresh?: boolean | null }) => {
			const result = mutation.reloadPackages({
				specs: variables.specs,
				fresh: variables.fresh ?? null,
			})
			result.ok
			result.error
			result.results.forEach((entry) => {
				entry.ok
				entry.code
				entry.error
				entry.spec?.name
			})
			return result
		},
		{ suspense: false },
	)

	const [reinstallPackagesMutation, reinstallBatchState] = useGqtyMutation(
		(mutation, variables: { specs: InstallPackageSpecInput[]; scope: UninstallPackageScopeInput }) => {
			const result = mutation.reinstallPackages({
				specs: variables.specs,
				force: true,
				scope: variables.scope,
			})
			result.ok
			result.error
			result.results.forEach((entry) => {
				entry.ok
				entry.code
				entry.error
				entry.installStatus
				entry.spec?.name
			})
			return result
		},
		{ suspense: false },
	)

	const [uninstallPackagesMutation, uninstallBatchState] = useGqtyMutation(
		(mutation, variables: { specs: InstallPackageSpecInput[]; scope: UninstallPackageScopeInput }) => {
			const result = mutation.uninstallPackages({
				specs: variables.specs,
				scope: variables.scope,
			})
			result.ok
			result.error
			result.results.forEach((entry) => {
				entry.ok
				entry.code
				entry.error
				entry.spec?.name
			})
			return result
		},
		{ suspense: false },
	)

	const refreshing = query.$state.isLoading
	const busy =
		installState.isLoading ||
		reinstallState.isLoading ||
		uninstallState.isLoading ||
		reloadBatchState.isLoading ||
		reinstallBatchState.isLoading ||
		uninstallBatchState.isLoading
	const refetchFn = query.$refetch

	const refetch = useCallback(async () => {
		await refetchFn(true)
	}, [refetchFn])

	const summarizeBatchResult = useCallback(
		(
			result: PackageBatchMutationResult | null | undefined,
			successTitle: string,
			fallbackError: string,
		) => {
			if (!result) {
				throw new Error(fallbackError)
			}
			const successes = result.results.filter((item) => item?.ok)
			const failures = result.results.filter((item) => !item?.ok)
			if (successes.length) {
				const names = successes.map(
					(item) => item.spec?.name || item.spec?.raw || item.code || '未知包',
				)
				const message =
					names.length <= 4
						? names.join('、')
						: `${names.slice(0, 4).join('、')} 等${names.length}个`
				notify({
					title: successTitle,
					message,
					color: 'green',
				})
			}
			if (failures.length) {
				const messages = failures.map((item) => {
					const label = item.spec?.name || item.spec?.raw || '未知包'
					return `${label}: ${item.error ?? item.code ?? '未知错误'}`
				})
				const message =
					messages.length <= 3
						? messages.join('；')
						: `${messages.slice(0, 3).join('；')} 等${messages.length}个失败`
				notify({
					title: '部分操作失败',
					message,
					color: 'red',
				})
			}
		},
		[notify],
	)

	const handleInstall = async () => {
		const specs = pendingInstallSpecs
		if (!specs.length) {
			notify({
				title: '请输入包名',
				message: '例如：pluxel-plugin-redis 或 @scope/pkg@1.0.0，每行一个。',
				color: 'yellow',
			})
			return
		}

		const successes: string[] = []
		const failures: string[] = []

		try {
			for (const raw of specs) {
				try {
					const result = await installPackageMutation({
						args: { spec: { raw }, force: forceInstall },
					})
					if (!result?.ok) {
						failures.push(`${raw}: ${result?.error ?? result?.code ?? '未知错误'}`)
					} else {
						successes.push(result.spec?.name ?? raw)
					}
				} catch (error: any) {
					failures.push(`${raw}: ${error?.message ?? '网络错误'}`)
				}
			}
		} finally {
			if (successes.length) {
				const list =
					successes.length <= 3
						? successes.join('、')
						: `${successes.slice(0, 3).join('、')} 等${successes.length}个`
				notify({
					title: '安装完成',
					message: `${list} 已完成安装`,
					color: 'green',
				})
				if (successes.length === specs.length) {
					setInstallInput('')
				}
				await refetch()
			}
			if (failures.length) {
				const list =
					failures.length <= 3
						? failures.join('；')
						: `${failures.slice(0, 3).join('；')} 等${failures.length}个失败`
				notify({
					title: '部分安装失败',
					message: list,
					color: 'red',
				})
			}
		}
	}

	const submitInstall: FormEventHandler<HTMLFormElement> = (event) => {
		event.preventDefault()
		void handleInstall()
	}

	const ensureHasSelection = useCallback(() => {
		if (selectedRows.length === 0) {
			notify({
				title: '请选择包',
				message: '请先在列表中勾选至少一个包后再执行批量操作。',
				color: 'yellow',
			})
			return false
		}
		return true
	}, [notify, selectedRows.length])

	const handleBatchReload = async (fresh = true) => {
		if (!ensureHasSelection()) return
		try {
			const result = await reloadPackagesMutation({
				args: { specs: selectedRows.map(toSpecInput), fresh },
			})
			summarizeBatchResult(result, '已重载所选包', '重载失败')
			if (result?.results?.length) {
				await refetch()
			}
		} catch (error: any) {
			notify({
				title: '重载失败',
				message: error?.message ?? '操作失败，请稍后再试',
				color: 'red',
			})
		}
	}

	const handleBatchReinstall = async (scope: UninstallPackageScopeInput) => {
		if (!ensureHasSelection()) return
		try {
			const result = await reinstallPackagesMutation({
				args: { specs: selectedRows.map(toSpecInput), scope },
			})
			summarizeBatchResult(
				result,
				scope === 'runtime' ? '已重装运行态' : '已重装并刷新持久态',
				'重装失败',
			)
			if (result?.results?.length) {
				await refetch()
			}
		} catch (error: any) {
			notify({
				title: '重装失败',
				message: error?.message ?? '操作失败，请稍后再试',
				color: 'red',
			})
		}
	}

	const handleBatchUninstall = async (scope: UninstallPackageScopeInput) => {
		if (!ensureHasSelection()) return
		try {
			const result = await uninstallPackagesMutation({
				args: { specs: selectedRows.map(toSpecInput), scope },
			})
			summarizeBatchResult(
				result,
				scope === 'runtime' ? '已卸载运行态' : '已彻底卸载',
				'卸载失败',
			)
			if (result?.results?.length) {
				await refetch()
			}
			clearSelection()
		} catch (error: any) {
			notify({
				title: '卸载失败',
				message: error?.message ?? '操作失败，请稍后再试',
				color: 'red',
			})
		}
	}

	const confirmBatchUninstall = (scope: UninstallPackageScopeInput) => {
		if (!ensureHasSelection()) return
		const title = scope === 'persisted' ? '彻底卸载所选包' : '卸载运行态缓存'
		const description =
			scope === 'persisted'
				? '将从运行态和持久依赖中移除所选包，下次需重新安装。'
				: '仅移除运行态缓存，持久化依赖仍然保留。'
		const preview =
			selectedRows.length <= 5
				? selectedRows.map((row) => row.name).join('、')
				: `${selectedRows
						.slice(0, 5)
						.map((row) => row.name)
						.join('、')} 等${selectedRows.length}个`
		openConfirmModal({
			title,
			children: (
				<Text size="sm">
					{description}
					<br />
					目标：{preview}
				</Text>
			),
			labels: { confirm: '确认', cancel: '取消' },
			confirmProps: { color: scope === 'persisted' ? 'red' : 'orange' },
			onConfirm: () => void handleBatchUninstall(scope),
		})
	}

	const performReinstall = async (row: PackageRow, scope: UninstallPackageScopeInput) => {
		const spec = toSpecInput(row)
		try {
			const result = await reinstallPackageMutation({ args: { spec, scope } })
			if (!result?.ok) {
				notify({
					title: '重装失败',
					message: result?.error ?? result?.code ?? '操作失败，请稍后重试',
					color: 'red',
				})
				return
			}
			notify({
				title: '已重装',
				message: `${row.name} 已重新载入（${scope === 'persisted' ? '包含持久态' : '运行态'}）`,
				color: 'green',
			})
			await refetch()
		} catch (error: any) {
			notify({
				title: '重装失败',
				message: error?.message ?? '操作失败，请稍后重试',
				color: 'red',
			})
		}
	}

	const performUninstall = async (row: PackageRow, scope: UninstallPackageScopeInput) => {
		const spec = toSpecInput(row)
		try {
			const result = await uninstallPackageMutation({ args: { spec, scope } })
			if (!result?.ok) {
				notify({
					title: '卸载失败',
					message: result?.error ?? result?.code ?? '操作失败，请稍后再试',
					color: 'red',
				})
				return
			}
			notify({
				title: '已卸载',
				message: `${row.name} 已移除（${scope === 'persisted' ? '含持久态' : '仅运行态'}）`,
				color: 'green',
			})
			await refetch()
		} catch (error: any) {
			notify({
				title: '卸载失败',
				message: error?.message ?? '操作失败，请稍后再试',
				color: 'red',
			})
		}
	}

	const confirmAndUninstall = (row: PackageRow, scope: UninstallPackageScopeInput) => {
		const title = scope === 'persisted' ? '彻底卸载包' : '卸载运行态缓存'
		const description =
			scope === 'persisted'
				? '该操作会从持久化状态中移除包信息，下次需要重新安装。'
				: '该操作会移除当前运行态缓存，重新加载时仍会使用持久化版本。'
		openConfirmModal({
			title,
			children: (
				<Text size="sm">
					{description}
					<br />
					目标：<b>{row.name}</b>
				</Text>
			),
			labels: { confirm: '确认', cancel: '取消' },
			confirmProps: { color: scope === 'persisted' ? 'red' : 'orange' },
			onConfirm: () => void performUninstall(row, scope),
		})
	}

	const sortedIssues = useMemo(
		() =>
			[...loadIssues]
				.filter((issue): issue is PackageLoadIssue => Boolean(issue))
				.sort((a, b) => (b.recordedAt ?? 0) - (a.recordedAt ?? 0)),
		[loadIssues],
	)

	const errorMessage = query.$state.error?.message ?? null

	const renderPackageTable = () => {
		if (filteredRows.length === 0) {
			return (
				<Box
					p="md"
					style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center' }}
				>
					{refreshing ? (
						<Group gap="sm">
							<Loader size="sm" />
							<Text c="dimmed">正在加载包信息…</Text>
						</Group>
					) : (
						<Text c="dimmed">
							{searchActive
								? `没有匹配“${packageSearch.trim()}”的结果`
								: '暂无包数据，可先安装或等待插件上报。'}
						</Text>
					)}
				</Box>
			)
		}

		const allVisibleSelected =
			filteredRows.length > 0 && selectedVisibleCount === filteredRows.length
		const isIndeterminate =
			selectedVisibleCount > 0 && selectedVisibleCount < filteredRows.length

		return (
			<Stack gap="xs" style={{ height: '100%' }}>
				{selectedPackages.size ? (
					<Group justify="space-between" align="center" wrap="wrap">
						<Group gap="xs" wrap="wrap">
							<Badge color="blue" variant="light">
								已选 {selectedPackages.size} 项
							</Badge>
							<Button
								variant="light"
								size="xs"
								leftSection={<IconRefresh size={14} />}
								onClick={() => void handleBatchReload(true)}
								loading={reloadBatchState.isLoading}
							>
								重载
							</Button>
							<Button
								variant="light"
								size="xs"
								leftSection={<IconRotateClockwise size={14} />}
								onClick={() => void handleBatchReinstall('runtime')}
								loading={reinstallBatchState.isLoading}
							>
								重装运行态
							</Button>
							<Button
								variant="filled"
								size="xs"
								leftSection={<IconRotateClockwise size={14} />}
								onClick={() => void handleBatchReinstall('persisted')}
								loading={reinstallBatchState.isLoading}
							>
								重装并刷新持久态
							</Button>
							<Button
								variant="light"
								size="xs"
								color="orange"
								leftSection={<IconTrash size={14} />}
								onClick={() => confirmBatchUninstall('runtime')}
								loading={uninstallBatchState.isLoading}
							>
								卸载运行态
							</Button>
							<Button
								variant="light"
								size="xs"
								color="red"
								leftSection={<IconTrash size={14} />}
								onClick={() => confirmBatchUninstall('persisted')}
								loading={uninstallBatchState.isLoading}
							>
								彻底卸载
							</Button>
						</Group>
						<Button variant="subtle" size="xs" onClick={clearSelection}>
							清空选择
						</Button>
					</Group>
				) : null}
				<ScrollArea style={{ height: '100%' }}>
					<Table striped highlightOnHover miw={720}>
						<Table.Thead>
							<Table.Tr>
								<Table.Th w={42}>
									<Checkbox
										checked={allVisibleSelected}
										indeterminate={isIndeterminate}
										onChange={(event) => toggleSelectAllVisible(event.currentTarget.checked)}
										aria-label="全选"
									/>
								</Table.Th>
								<Table.Th>包</Table.Th>
								<Table.Th>版本</Table.Th>
								<Table.Th>引用插件</Table.Th>
								<Table.Th>状态</Table.Th>
								<Table.Th>操作</Table.Th>
							</Table.Tr>
						</Table.Thead>
						<Table.Tbody>
							{filteredRows.map((row) => (
								<Table.Tr key={row.name}>
									<Table.Td>
										<Checkbox
											checked={selectedPackages.has(row.name)}
											onChange={(event) =>
												setRowSelected(row.name, event.currentTarget.checked)
											}
											aria-label={`选择 ${row.name}`}
										/>
									</Table.Td>
									<Table.Td>
										<Flex gap={6} align="center" wrap="wrap">
											<Text fw={600}>{row.name}</Text>
											{row.pluginNames.length > 0 ? (
												row.pluginNames.map((plugin) => (
													<Badge
														key={plugin}
														variant="light"
														color="blue"
														component={RouterLinkAdapter}
														to={`/plugins/${encodeURIComponent(plugin)}`}
														style={{ cursor: 'pointer' }}
													>
														{plugin}
													</Badge>
												))
											) : (
												<Text size="xs" c="dimmed">
													暂无关联插件
												</Text>
											)}
										</Flex>
									</Table.Td>
									<Table.Td>
										<Badge variant="light" color="blue">
											{formatSpec(row)}
										</Badge>
									</Table.Td>
									<Table.Td>
										<Text size="sm">
											{row.runningCount}/{row.pluginCount} 运行中
										</Text>
									</Table.Td>
									<Table.Td>
										{row.issues.length ? (
											<Badge color="red" variant="filled">
												{row.issues.length} 个告警
											</Badge>
										) : (
											<Badge color="green" variant="light">
												正常
											</Badge>
										)}
									</Table.Td>
									<Table.Td>
										<Group justify="flex-end" gap="xs">
											<Button
												variant="light"
												size="xs"
												leftSection={<IconRotateClockwise size={14} />}
												onClick={() => void performReinstall(row, 'runtime')}
												disabled={busy}
											>
												重装
											</Button>
											<Menu withinPortal position="bottom-end">
												<Menu.Target>
													<ActionIcon variant="subtle" color="gray" disabled={busy}>
														<IconDotsVertical size={16} />
													</ActionIcon>
												</Menu.Target>
												<Menu.Dropdown>
													<Menu.Item
														leftSection={<IconRefresh size={14} />}
														onClick={() => void performReinstall(row, 'persisted')}
														disabled={busy}
													>
														重装并刷新持久态
													</Menu.Item>
													<Menu.Item
														leftSection={<IconTrash size={14} />}
														onClick={() => confirmAndUninstall(row, 'runtime')}
														disabled={busy}
													>
														卸载运行态
													</Menu.Item>
													<Menu.Item
														color="red"
														leftSection={<IconTrash size={14} />}
														onClick={() => confirmAndUninstall(row, 'persisted')}
														disabled={busy}
													>
														彻底卸载
													</Menu.Item>
												</Menu.Dropdown>
											</Menu>
										</Group>
									</Table.Td>
								</Table.Tr>
							))}
						</Table.Tbody>
					</Table>
				</ScrollArea>
			</Stack>
		)
	}

	const renderIssues = () => {
		if (sortedIssues.length === 0) {
			return (
				<Text c="dimmed" size="sm">
					暂无告警。
				</Text>
			)
		}

		return (
			<ScrollArea style={{ height: '100%' }}>
				<Stack gap="sm" pr="md">
					{sortedIssues.map((issue) => {
						const key = `${issue.spec?.name ?? 'unknown'}-${issue.recordedAt ?? 0}`
						return (
							<Card key={key} withBorder radius="md" padding="sm">
								<Stack gap={4}>
									<Group gap="xs">
										<Badge color="red" size="xs">
											{ISSUE_SOURCE_LABEL[issue.source ?? 'load'] ?? '未知'}
										</Badge>
										<Text fw={600} size="sm">
											{issue.spec?.name}
										</Text>
										<Text size="xs" c="dimmed">
											{formatSpec({
												name: issue.spec?.name ?? '',
												version: issue.spec?.version ?? null,
												tag: issue.spec?.tag ?? null,
												raw: issue.spec?.raw ?? null,
												pluginCount: 0,
												runningCount: 0,
												pluginNames: [],
												issues: [],
											})}
										</Text>
									</Group>
									<Text size="sm" c="red.6">
										{issue.message}
									</Text>
									{issue.error ? (
										<Text size="xs" c="dimmed">
											{issue.error}
										</Text>
									) : null}
									<Text size="xs" c="dimmed">
										{formatTimestamp(issue.recordedAt)} · 入口：
										{issue.spec?.target || '未知入口'}
									</Text>
								</Stack>
							</Card>
						)
					})}
				</Stack>
			</ScrollArea>
		)
	}

	return (
		<Stack gap="md" style={{ flex: 1, minHeight: 0 }}>
			<Group justify="space-between" align="flex-start" wrap="wrap" gap="sm">
				<Stack gap={4} style={{ minWidth: 200 }}>
					<Title order={2}>包管理</Title>
					<Text c="dimmed" size="sm">
						查看已安装的包，快速执行安装、热重装与卸载操作。
					</Text>
				</Stack>
				<Group>
					<Group gap="sm" wrap="wrap">
						{summaryStats.map((stat) => (
							<Paper
								key={stat.label}
								withBorder
								shadow="xs"
								radius="md"
								px="md"
								py="xs"
								style={{ minWidth: 120 }}
							>
								<Text size="xs" c="dimmed">
									{stat.label}
								</Text>
								<Text fw={700} size="lg" c={stat.color}>
									{stat.value}
								</Text>
							</Paper>
						))}
					</Group>
					<Button
						leftSection={<IconRefresh size={16} />}
						variant="light"
						onClick={() => void refetch()}
						loading={refreshing && rows.length === 0}
					>
						刷新数据
					</Button>
				</Group>
			</Group>

			{errorMessage ? (
				<Alert color="red" icon={<IconAlertTriangle size={18} />} title="加载失败">
					{errorMessage}
				</Alert>
			) : null}

			<Grid columns={12} gutter="md">
				<Grid.Col span={{ base: 12, md: 7 }}>
					<Card
						withBorder
						shadow="sm"
						component="form"
						onSubmit={submitInstall}
						style={{ height: '100%' }}
					>
						<CardSection px="md" py="sm" withBorder>
							<Stack gap={4}>
								<Title order={5}>安装新包</Title>
								<Text size="xs" c="dimmed">
									支持 npm 全量语法，例如 name、name@1.2.3。
								</Text>
							</Stack>
						</CardSection>
						<CardSection px="md" py="sm">
							<Stack gap="sm">
								<Textarea
									label="包名或语义化输入"
									description="支持一次输入多行，换行或逗号分隔。"
									placeholder="pluxel-plugin-redis&#10;@scope/pkg@1.0.0"
									value={installInput}
									onChange={(event) => setInstallInput(event.currentTarget.value)}
									required
									minRows={3}
									autosize
								/>
								{pendingInstallSpecs.length > 0 ? (
									<Stack gap={4}>
										<Text size="xs" c="dimmed">
											将安装 {pendingInstallSpecs.length} 个条目：
										</Text>
										<Group gap={4} wrap="wrap">
											{pendingInstallSpecs.map((spec) => (
												<Badge key={spec} color="gray" variant="light">
													{spec}
												</Badge>
											))}
										</Group>
									</Stack>
								) : null}
								<Group justify="space-between" align="center">
									<Checkbox
										label="强制安装"
										description="忽略已缓存版本"
										checked={forceInstall}
										onChange={(event) => setForceInstall(event.currentTarget.checked)}
										size="sm"
									/>
									<Button type="submit" loading={installState.isLoading}>
										{pendingInstallSpecs.length > 1 ? '批量安装' : '开始安装'}
									</Button>
								</Group>
							</Stack>
						</CardSection>
					</Card>
				</Grid.Col>
				<Grid.Col span={{ base: 12, md: 5 }}>
					<Card
						withBorder
						shadow="sm"
						style={{ height: '100%', display: 'flex', flexDirection: 'column' }}
					>
						<CardSection withBorder px="md" py="sm">
							<Group justify="space-between">
								<Group gap="xs">
									<IconAlertTriangle size={16} color="var(--mantine-color-red-6)" />
									<Text fw={600}>加载告警</Text>
								</Group>
								<Badge color={sortedIssues.length ? 'red' : 'green'} variant="light">
									{sortedIssues.length} 项
								</Badge>
							</Group>
						</CardSection>
						<CardSection px="md" py="sm" style={{ flex: 1, minHeight: 0 }}>
							{renderIssues()}
						</CardSection>
					</Card>
				</Grid.Col>
			</Grid>

			<Flex
				gap="md"
				align="stretch"
				wrap="wrap"
				style={{ flex: 1, minHeight: 0 }}
				justify="flex-start"
			>
				<Card
					withBorder
					shadow="sm"
					style={{
						flex: '1 1 100%',
						minWidth: 320,
						minHeight: 0,
						display: 'flex',
						flexDirection: 'column',
					}}
				>
					<CardSection withBorder px="md" py="sm">
						<Group justify="space-between" align="center" wrap="wrap">
							<Stack gap={2}>
								<Title order={5}>已安装的包</Title>
								<Text size="xs" c="dimmed">
									{filteredRows.length} / {rows.length} 项
								</Text>
							</Stack>
							<TextInput
								placeholder="搜索包名或插件"
								leftSection={<IconSearch size={14} />}
								value={packageSearch}
								onChange={(event) => setPackageSearch(event.currentTarget.value)}
								size="sm"
								style={{ minWidth: 220 }}
							/>
						</Group>
					</CardSection>
					<CardSection px="md" py="sm" style={{ flex: 1, minHeight: 0 }}>
						{renderPackageTable()}
					</CardSection>
				</Card>
			</Flex>
		</Stack>
	)
}
