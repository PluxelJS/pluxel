import { Alert, Badge, Box, Group, Paper, Stack, Text } from '@mantine/core'
import { useHotkeys } from '@mantine/hooks'
import { openConfirmModal } from '@mantine/modals'
import { IconAlertTriangle } from '@tabler/icons-react'
import {
	useCallback,
	useDeferredValue,
	useEffect,
	useMemo,
	useRef,
	useState,
	type FormEventHandler,
} from 'react'
import {
	type PackageBatchResult,
	type PackageInventoryEntry,
	type PackageLoadIssue,
	type PackageManagerFeatureApi,
	type PackageSpecInput,
	useRuntimeTransportClient,
} from '../../runtime'
import { useNotify } from '../hooks/useNotify'
import {
	buildPackageRows,
	filterPackageRows,
	parseInstallSpecs,
	summarizeList,
	toSpecInput,
	toIssueDataList,
	type IssueData,
	type OperationLogEntry,
	type PackageBusyKey,
	type PackageRow,
} from './packageManagerModel'
import { PackageInstallPanel } from './PackageInstallPanel'
import { PackageIssuesPanel } from './PackageIssuesPanel'
import { PackageManagerToolbar, type PackageSummaryStat } from './PackageManagerToolbar'
import { PackageOperationLogModal } from './PackageOperationLogModal'
import { PackageTable } from './PackageTable'
import { ErrorState } from '../../components'
import { usePluginOverview } from '../plugins/pluginOverview'
import { useStoredSplitLayout, WorkbenchSplitView } from '../workbench/split'
import {
	DEFAULT_PACKAGE_SPLIT_LAYOUT,
	PACKAGE_INSTALL_PANEL_ID,
	PACKAGE_LIST_PANEL_ID,
	PACKAGE_SPLIT_LAYOUT_STORAGE_KEY,
	sanitizePackageSplitLayout,
} from './packageManagerLayout'

export function PackageManagerScreen() {
	const transport = useRuntimeTransportClient()
	const [showAllPackages, setShowAllPackages] = useState(false)
	const [showIssuesPanel, setShowIssuesPanel] = useState(true)
	const searchInputRef = useRef<HTMLInputElement>(null)
	const overviewState = usePluginOverview()

	const [inventory, setInventory] = useState<PackageInventoryEntry[]>([])
	const [loadIssues, setLoadIssues] = useState<PackageLoadIssue[]>([])
	const [pageError, setPageError] = useState<Error | null>(null)
	const [inlineError, setInlineError] = useState<string | null>(null)
	const [refreshing, setRefreshing] = useState(false)
	const inflightRef = useRef<Promise<void> | null>(null)
	const inflightKeyRef = useRef<string | null>(null)
	const requestIdRef = useRef(0)
	const hasSnapshotRef = useRef(false)
	const snapshotKeyRef = useRef('')

	const [installInput, setInstallInput] = useState('')
	const [forceInstall, setForceInstall] = useState(false)
	const notify = useNotify()
	const pendingInstallSpecs = useMemo(() => parseInstallSpecs(installInput), [installInput])

	const withPackageManager = useCallback(
		async <T,>(runner: (feature: PackageManagerFeatureApi) => Promise<T>): Promise<T> => {
			return await transport.withRpc(async (rpc) => {
				const feature = await rpc.packageManager()
				if (!feature) throw new Error('当前运行路线不支持包管理功能')
				return await runner(feature)
			})
		},
		[transport],
	)

	const statuses = useMemo(() => {
		try {
			return [...(overviewState.overview?.status?.statuses ?? [])]
		} catch (error) {
			console.error('[PackageManager] failed to read plugin statuses', error)
			return []
		}
	}, [overviewState.overview?.status?.statuses])

	const refetch = useCallback(
		async (options?: { force?: boolean }) => {
			const snapshotKey = showAllPackages ? 'all' : 'tracked'
			if (inflightRef.current && inflightKeyRef.current === snapshotKey) {
				if (!options?.force) return inflightRef.current
				await inflightRef.current
			}
			const hasSnapshot = hasSnapshotRef.current && snapshotKeyRef.current === snapshotKey
			const requestId = ++requestIdRef.current
			const task = (async () => {
				setRefreshing(true)
				setInlineError(null)
				if (!hasSnapshot) setPageError(null)
				try {
					const result = await withPackageManager(async (pkg) => {
						const snapshot = await pkg.snapshot({ includeUntracked: showAllPackages })
						return { inventory: snapshot.inventory, issues: snapshot.loadIssues }
					})
					if (requestId !== requestIdRef.current) return
					setInventory(Array.isArray(result.inventory) ? result.inventory : [])
					setLoadIssues(Array.isArray(result.issues) ? result.issues : [])
					hasSnapshotRef.current = true
					snapshotKeyRef.current = snapshotKey
					setPageError(null)
				} catch (error) {
					const message =
						error instanceof Error ? error.message : error ? String(error) : '无法加载包管理数据'
					if (requestId !== requestIdRef.current) return
					if (hasSnapshot) setInlineError(message)
					else setPageError(error instanceof Error ? error : new Error(message))
				} finally {
					if (requestId === requestIdRef.current) {
						setRefreshing(false)
						inflightRef.current = null
						inflightKeyRef.current = null
					}
				}
			})()
			inflightRef.current = task
			inflightKeyRef.current = snapshotKey
			return task
		},
		[withPackageManager, showAllPackages],
	)

	useEffect(() => {
		void refetch()
	}, [refetch])

	const rows = useMemo(
		() => buildPackageRows(statuses, loadIssues, inventory),
		[statuses, loadIssues, inventory],
	)
	const totalPackages = rows.length
	const runningPackages = rows.filter((row) => row.runningCount > 0).length
	const packagesWithIssues = rows.filter((row) => row.issues.length > 0).length
	const packageConsumers = useMemo(
		() => statuses.filter((entry) => entry?.source?.kind === 'package').length,
		[statuses],
	)
	const summaryStats: PackageSummaryStat[] = [
		{ label: '包总数', value: totalPackages },
		{ label: '被引用插件', value: packageConsumers },
		{ label: '运行中的包', value: runningPackages },
		{ label: '存在告警', value: packagesWithIssues, color: packagesWithIssues ? 'red' : undefined },
	]
	const [packageSearch, setPackageSearch] = useState('')
	const deferredPackageSearch = useDeferredValue(packageSearch.trim().toLowerCase())
	const searchActive = deferredPackageSearch.length > 0
	// Keeps fast typing from making the table flash between result sets.
	const isSearchTransitioning = packageSearch.trim().toLowerCase() !== deferredPackageSearch
	const filteredRows = useMemo(
		() => filterPackageRows(rows, deferredPackageSearch),
		[rows, deferredPackageSearch],
	)

	const [selectedPackages, setSelectedPackages] = useState<Set<string>>(new Set())
	const selectedRows = useMemo(
		() => rows.filter((row) => selectedPackages.has(row.name)),
		[rows, selectedPackages],
	)
	const selectedVisibleCount = useMemo(
		() => filteredRows.filter((row) => selectedPackages.has(row.name)).length,
		[filteredRows, selectedPackages],
	)

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

	// Keyboard shortcuts
	useHotkeys([
		[
			'mod+f',
			(e) => {
				e.preventDefault()
				searchInputRef.current?.focus()
				searchInputRef.current?.select()
			},
		],
		[
			'Escape',
			() => {
				if (document.activeElement === searchInputRef.current) {
					setPackageSearch('')
					searchInputRef.current?.blur()
				}
			},
		],
		[
			'mod+a',
			(e) => {
				if (document.activeElement === searchInputRef.current) return
				e.preventDefault()
				toggleSelectAllVisible(true)
			},
		],
	])

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

	const [busyKey, setBusyKey] = useState<PackageBusyKey | null>(null)
	const busy = busyKey !== null

	const summarizeBatchResult = useCallback(
		(
			result: PackageBatchResult | null | undefined,
			successTitle: string,
			fallbackError: string,
		) => {
			if (!result) {
				throw new Error(fallbackError)
			}
			const successes = result.results.filter((item) => item?.ok)
			const failures = result.results.filter((item) => !item?.ok)
			if (successes.length > 0) {
				const names = successes.map(
					(item) => item.spec?.name || item.spec?.raw || item.code || '未知包',
				)
				notify({
					title: successTitle,
					message: summarizeList(names, 4, '个'),
					color: 'green',
				})
			}
			const messages = failures.map((item) => {
				const label = item.spec?.name || item.spec?.raw || '未知包'
				return `${label}: ${item.error ?? item.code ?? '未知错误'}`
			})
			if (result.error) {
				messages.push(result.error)
			}
			if (messages.length > 0) {
				notify({
					title: '部分操作失败',
					message: summarizeList(messages, 3, '个失败', '；'),
					color: 'red',
				})
			}
		},
		[notify],
	)

	const runPackageMutation = useCallback(
		async (
			action: 'install' | 'uninstall' | 'remove' | 'reinstall' | 'reload' | 'retry',
			specs: PackageSpecInput[],
			options?: { force?: boolean; fresh?: boolean; reinstall?: boolean },
		): Promise<PackageBatchResult> => {
			const result = await withPackageManager((pkg) => pkg.mutate({ action, specs, options }))
			await refetch({ force: true })
			return result
		},
		[refetch, withPackageManager],
	)

	const applyOperationLogs = useCallback((result?: PackageBatchResult | null) => {
		setOperationLogs((prev) =>
			prev.map((log) => {
				const entry = result?.results?.find(
					(r) => r.spec?.name === log.label || r.spec?.raw === log.label,
				)
				if (!entry) return { ...log, status: 'success' }
				return entry.ok
					? { ...log, status: 'success' }
					: { ...log, status: 'error', message: entry.error ?? entry.code ?? '未知错误' }
			}),
		)
	}, [])

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

	const openBatchOperationLog = useCallback((title: string, targets: string[]) => {
		setOperationTitle(title)
		setOperationLogs(targets.map((name) => ({ label: name, status: 'running' })))
		setOperationLogOpen(true)
	}, [])

	const markOperationLogsFailed = useCallback((message?: string) => {
		setOperationLogs((prev) =>
			prev.map((log) => ({ ...log, status: 'error', message: message ?? log.message })),
		)
	}, [])

	const runSelectedBatchOperation = useCallback(
		async (config: {
			action: 'reload' | 'reinstall' | 'uninstall' | 'remove'
			logTitle: string
			successTitle: string
			errorTitle: string
			fallbackError: string
			busyKey: PackageBusyKey
			options?: { force?: boolean; fresh?: boolean; reinstall?: boolean }
			clearSelection?: boolean
		}) => {
			if (busy) return
			if (!ensureHasSelection()) return
			const targets = selectedRows.map((row) => row.name)
			openBatchOperationLog(config.logTitle, targets)
			setBusyKey(config.busyKey)
			try {
				const result = await runPackageMutation(
					config.action,
					selectedRows.map(toSpecInput),
					config.options,
				)
				applyOperationLogs(result)
				summarizeBatchResult(result, config.successTitle, config.fallbackError)
				if (config.clearSelection) clearSelection()
			} catch (error: any) {
				markOperationLogsFailed(error?.message)
				notify({
					title: config.errorTitle,
					message: error?.message ?? '操作失败，请稍后再试',
					color: 'red',
				})
			} finally {
				setBusyKey(null)
			}
		},
		[
			applyOperationLogs,
			busy,
			clearSelection,
			ensureHasSelection,
			markOperationLogsFailed,
			notify,
			openBatchOperationLog,
			runPackageMutation,
			selectedRows,
			summarizeBatchResult,
		],
	)

	const openSelectedPackagesConfirm = useCallback(
		(config: {
			title: string
			description: string
			confirmLabel: string
			confirmColor: string
			onConfirm: () => void
		}) => {
			if (!ensureHasSelection()) return
			const preview = summarizeList(
				selectedRows.map((row) => row.name),
				5,
				'个',
			)
			openConfirmModal({
				title: config.title,
				children: (
					<Text size="sm">
						{config.description}
						<br />
						目标：{preview}
					</Text>
				),
				labels: { confirm: config.confirmLabel, cancel: '取消' },
				confirmProps: { color: config.confirmColor },
				onConfirm: config.onConfirm,
			})
		},
		[ensureHasSelection, selectedRows],
	)

	const runRowOperation = useCallback(
		async (config: {
			row: PackageRow
			action: 'reload' | 'reinstall' | 'uninstall' | 'remove'
			busyKey: PackageBusyKey
			successTitle: string
			successMessage: string
			errorTitle: string
			options?: { force?: boolean; fresh?: boolean; reinstall?: boolean }
		}) => {
			if (busy) return
			const spec = toSpecInput(config.row)
			setBusyKey(config.busyKey)
			try {
				const result = await runPackageMutation(config.action, [spec], config.options)
				const entry = result?.results?.[0]
				if (!entry || result?.error || entry.ok === false) {
					notify({
						title: config.errorTitle,
						message: result?.error ?? entry?.error ?? entry?.code ?? '操作失败，请稍后再试',
						color: 'red',
					})
					return
				}
				notify({
					title: config.successTitle,
					message: config.successMessage,
					color: 'green',
				})
			} catch (error: any) {
				notify({
					title: config.errorTitle,
					message: error?.message ?? '操作失败，请稍后再试',
					color: 'red',
				})
			} finally {
				setBusyKey(null)
			}
		},
		[busy, notify, runPackageMutation],
	)

	const openRowConfirm = useCallback(
		(config: {
			row: PackageRow
			title: string
			description: string
			confirmLabel: string
			confirmColor: string
			onConfirm: (row: PackageRow) => void
		}) => {
			openConfirmModal({
				title: config.title,
				children: (
					<Text size="sm">
						{config.description}
						<br />
						目标：<b>{config.row.name}</b>
					</Text>
				),
				labels: { confirm: config.confirmLabel, cancel: '取消' },
				confirmProps: { color: config.confirmColor },
				onConfirm: () => config.onConfirm(config.row),
			})
		},
		[],
	)

	const handleInstall = async () => {
		if (busy) return
		const specs = pendingInstallSpecs
		if (specs.length === 0) {
			notify({
				title: '请输入包名',
				message: '例如：pluxel-plugin-redis 或 @scope/pkg@1.0.0，每行一个。',
				color: 'yellow',
			})
			return
		}

		const successes: string[] = []
		const failures: string[] = []
		setBusyKey('install')

		try {
			const specKey = (spec?: PackageSpecInput) => {
				const raw = spec?.raw?.trim()
				if (raw) return raw.toLowerCase()
				const name = spec?.name?.trim() ?? ''
				const hint = spec?.version ?? spec?.tag
				return (hint ? `${name}@${hint}` : name).toLowerCase()
			}

			const result = await runPackageMutation(
				'install',
				specs.map((raw) => ({ raw })),
				{ force: forceInstall },
			)
			if (!result) {
				throw new Error('安装接口无返回结果')
			}
			if (result.error) {
				failures.push(result.error)
			}

			const resultsByKey = new Map(
				result.results.map((entry) => [specKey(entry.spec ?? undefined), entry]),
			)
			for (const raw of specs) {
				const entry = resultsByKey.get(specKey({ raw }))
				if (!entry) {
					failures.push(`${raw}: 未返回结果`)
					continue
				}
				if (entry.ok === false) {
					failures.push(`${raw}: ${entry.error ?? entry.code ?? '未知错误'}`)
				} else {
					successes.push(entry.spec?.name ?? raw)
				}
			}
		} catch (error: any) {
			failures.push(error?.message ?? '安装失败，请稍后再试')
		} finally {
			setBusyKey(null)
			if (successes.length > 0) {
				notify({
					title: '安装完成',
					message: `${summarizeList(successes, 3, '个')} 已完成安装`,
					color: 'green',
				})
				if (successes.length === specs.length) {
					setInstallInput('')
				}
			}
			if (failures.length > 0) {
				notify({
					title: '部分安装失败',
					message: summarizeList(failures, 3, '个失败', '；'),
					color: 'red',
				})
			}
		}
	}

	const submitInstall: FormEventHandler<HTMLFormElement> = (event) => {
		event.preventDefault()
		void handleInstall()
	}

	const handleBatchReload = async (fresh = true) => {
		await runSelectedBatchOperation({
			action: 'reload',
			logTitle: '重载包',
			successTitle: '已重载所选包',
			errorTitle: '重载失败',
			fallbackError: '重载失败',
			options: { fresh },
			busyKey: 'batch-reload',
		})
	}

	const handleBatchReinstall = async () => {
		await runSelectedBatchOperation({
			action: 'reinstall',
			logTitle: '重装包',
			successTitle: '已重装运行态',
			errorTitle: '重装失败',
			fallbackError: '重装失败',
			options: { force: true },
			busyKey: 'batch-reinstall',
		})
	}

	const handleBatchUninstall = async () => {
		await runSelectedBatchOperation({
			action: 'uninstall',
			logTitle: '卸载包',
			successTitle: '已卸载运行态',
			errorTitle: '卸载失败',
			fallbackError: '卸载失败',
			busyKey: 'batch-uninstall',
			clearSelection: true,
		})
	}

	const handleBatchRemove = async () => {
		await runSelectedBatchOperation({
			action: 'remove',
			logTitle: '移除包',
			successTitle: '已彻底移除',
			errorTitle: '移除失败',
			fallbackError: '移除失败',
			busyKey: 'batch-remove',
			clearSelection: true,
		})
	}

	const handleLoad = async (row: PackageRow) => {
		await runRowOperation({
			row,
			action: 'reload',
			busyKey: 'row-load',
			successTitle: '已加载包',
			successMessage: `${row.name} 已加载到运行态`,
			errorTitle: '加载失败',
			options: { fresh: true },
		})
	}

	const confirmBatchUninstall = () => {
		openSelectedPackagesConfirm({
			title: '卸载已加载模块',
			description: '仅移除已加载模块，不会删除持久化依赖。',
			confirmLabel: '确认',
			confirmColor: 'orange',
			onConfirm: () => void handleBatchUninstall(),
		})
	}

	const confirmBatchRemove = () => {
		openSelectedPackagesConfirm({
			title: '彻底移除所选包',
			description: '将从运行态和持久依赖中完全移除所选包，下次需重新安装。',
			confirmLabel: '确认移除',
			confirmColor: 'red',
			onConfirm: () => void handleBatchRemove(),
		})
	}

	const performReinstall = async (row: PackageRow) => {
		await runRowOperation({
			row,
			action: 'reinstall',
			busyKey: 'row-reinstall',
			successTitle: '已重装',
			successMessage: `${row.name} 已重新载入`,
			errorTitle: '重装失败',
			options: { force: true },
		})
	}

	const performUninstall = async (row: PackageRow) => {
		await runRowOperation({
			row,
			action: 'uninstall',
			busyKey: 'row-uninstall',
			successTitle: '已卸载',
			successMessage: `${row.name} 已从运行态移除`,
			errorTitle: '卸载失败',
		})
	}

	const confirmAndUninstall = (row: PackageRow) => {
		openRowConfirm({
			row,
			title: '卸载运行态缓存',
			description: '仅移除当前运行态缓存，重新加载时仍会使用已安装的版本。',
			confirmLabel: '确认',
			confirmColor: 'orange',
			onConfirm: (nextRow) => void performUninstall(nextRow),
		})
	}

	const performRemove = async (row: PackageRow) => {
		await runRowOperation({
			row,
			action: 'remove',
			busyKey: 'row-remove',
			successTitle: '已移除',
			successMessage: `${row.name} 已从系统中彻底移除`,
			errorTitle: '移除失败',
		})
	}

	const confirmAndRemove = (row: PackageRow) => {
		openRowConfirm({
			row,
			title: '彻底移除包',
			description: '该操作会从持久化状态中完全移除包信息，下次需要重新安装。',
			confirmLabel: '确认移除',
			confirmColor: 'red',
			onConfirm: (nextRow) => void performRemove(nextRow),
		})
	}

	const sortedIssues = useMemo<IssueData[]>(() => toIssueDataList(loadIssues), [loadIssues])

	// 操作日志状态
	const [operationLogOpen, setOperationLogOpen] = useState(false)
	const [operationLogs, setOperationLogs] = useState<OperationLogEntry[]>([])
	const [operationTitle, setOperationTitle] = useState('操作日志')

	const errorMessage = inlineError
	const [packageSplitLayout, handlePackageSplitLayoutChanged] = useStoredSplitLayout(
		PACKAGE_SPLIT_LAYOUT_STORAGE_KEY,
		DEFAULT_PACKAGE_SPLIT_LAYOUT,
		sanitizePackageSplitLayout,
	)

	// 顶层错误：不再继续渲染复杂 UI（会触发更多懒读取/请求），直接给稳定错误态 + 手动重试。
	if (pageError) {
		return (
			<ErrorState
				title="加载失败"
				message={pageError.message || '无法加载包管理数据'}
				onRetry={() => void refetch()}
				minHeight="100%"
			/>
		)
	}

	return (
		<Stack gap="sm" style={{ flex: 1, minHeight: 0 }}>
			<PackageManagerToolbar
				filteredCount={filteredRows.length}
				issueCount={sortedIssues.length}
				onOpenOperationLog={() => setOperationLogOpen(true)}
				onPackageSearchChange={setPackageSearch}
				onRefresh={() => void refetch()}
				onShowAllPackagesChange={setShowAllPackages}
				onShowIssuesPanel={() => setShowIssuesPanel(true)}
				packageSearch={packageSearch}
				refreshing={refreshing}
				rowCount={rows.length}
				searchInputRef={searchInputRef}
				showAllPackages={showAllPackages}
				showIssuesPanel={showIssuesPanel}
				stats={summaryStats}
			/>

			{errorMessage && (
				<Alert color="red" icon={<IconAlertTriangle size={18} />} title="加载失败">
					{errorMessage}
				</Alert>
			)}

			{sortedIssues.length > 0 && showIssuesPanel && (
				<PackageIssuesPanel
					issues={sortedIssues}
					maxHeight={180}
					onClose={() => setShowIssuesPanel(false)}
				/>
			)}

			<WorkbenchSplitView
				className="plx-workbench__panelGroup"
				layout={packageSplitLayout}
				id="pluxel-packages-split"
				onLayoutCommit={handlePackageSplitLayoutChanged}
				orientation="horizontal"
				primary={{
					id: PACKAGE_INSTALL_PANEL_ID,
					defaultSize: packageSplitLayout[PACKAGE_INSTALL_PANEL_ID],
					minSize: 18,
					children: (
						<PackageInstallPanel
							busy={busy}
							forceInstall={forceInstall}
							installInput={installInput}
							installing={busyKey === 'install'}
							onForceInstallChange={setForceInstall}
							onInstallInputChange={setInstallInput}
							onSubmit={submitInstall}
							pendingInstallSpecs={pendingInstallSpecs}
						/>
					),
				}}
				secondary={{
					id: PACKAGE_LIST_PANEL_ID,
					defaultSize: packageSplitLayout[PACKAGE_LIST_PANEL_ID],
					minSize: 52,
					children: (
						<Paper
							withBorder
							radius="sm"
							style={{
								flex: 1,
								minHeight: 0,
								display: 'flex',
								flexDirection: 'column',
							}}
						>
							<Box
								px="sm"
								py={6}
								style={{ borderBottom: '1px solid var(--mantine-color-default-border)' }}
							>
								<Group justify="space-between" align="center" wrap="wrap">
									<Group gap="xs">
										<Text fw={700} size="sm">
											包列表
										</Text>
										{searchActive ? (
											<Badge variant="light" color="gray">
												匹配 {filteredRows.length}
											</Badge>
										) : null}
									</Group>
									{selectedPackages.size > 0 ? (
										<Text size="xs" c="dimmed">
											已选 {selectedPackages.size} 项
										</Text>
									) : null}
								</Group>
							</Box>
							<Box
								px="sm"
								py="xs"
								style={{
									flex: 1,
									minHeight: 0,
									opacity: isSearchTransitioning ? 0.7 : 1,
									transition: 'opacity 100ms ease-out',
								}}
							>
								<PackageTable
									busy={busy}
									busyKey={busyKey}
									filteredRows={filteredRows}
									onBatchReinstall={() => void handleBatchReinstall()}
									onBatchReload={() => void handleBatchReload(true)}
									onBatchRemove={confirmBatchRemove}
									onBatchUninstall={confirmBatchUninstall}
									onClearSelection={clearSelection}
									onLoad={(row) => void handleLoad(row)}
									onRemove={confirmAndRemove}
									onReinstall={(row) => void performReinstall(row)}
									onRowSelectedChange={setRowSelected}
									onSelectAllVisibleChange={toggleSelectAllVisible}
									onUninstall={confirmAndUninstall}
									packageSearch={packageSearch}
									refreshing={refreshing}
									searchActive={searchActive}
									selectedPackages={selectedPackages}
									selectedVisibleCount={selectedVisibleCount}
								/>
							</Box>
						</Paper>
					),
				}}
			/>

			<PackageOperationLogModal
				opened={operationLogOpen}
				onClose={() => setOperationLogOpen(false)}
				title={operationTitle}
				logs={operationLogs}
			/>
		</Stack>
	)
}
