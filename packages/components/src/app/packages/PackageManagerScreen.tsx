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
	Group,
	Kbd,
	Loader,
	Paper,
	ScrollArea,
	Stack,
	Table,
	Text,
	Textarea,
	TextInput,
	Title,
	Tooltip,
} from '@mantine/core'
import { useHotkeys } from '@mantine/hooks'
import { openConfirmModal } from '@mantine/modals'
import {
	IconAlertTriangle,
	IconPackages,
	IconRefresh,
	IconRotateClockwise,
	IconSearch,
	IconSearch as IconSearchEmpty,
	IconTerminal2,
	IconTrash,
	IconX,
} from '@tabler/icons-react'
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
	type PackageSpecInput,
	useRuntimeTransportClient,
} from '../../runtime'
import { RouterLinkAdapter } from '../RouterLinkAdapter'
import { useNotify } from '../hooks'
import {
	buildPackageRows,
	filterPackageRows,
	formatSpec,
	parseInstallSpecs,
	summarizeList,
	toSpecInput,
	toIssueDataList,
	type IssueData,
	type OperationLogEntry,
	type PackageRow,
} from './packageManagerModel'
import { PackageIssuesPanel } from './PackageIssuesPanel'
import { PackageOperationLogModal } from './PackageOperationLogModal'
import { EmptyState, ErrorState } from '../../components'
import { usePluginOverview } from '../plugins/pluginOverviewStore'
import { subscribeInvalidations, invalidate } from '../data/invalidations'

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

	const statuses = useMemo(() => {
		try {
			return [...(overviewState.overview?.status?.statuses ?? [])]
		} catch (error) {
			console.error('[PackageManager] failed to read plugin statuses', error)
			return []
		}
	}, [overviewState.overview?.status?.statuses])

	const refetch = useCallback(async () => {
		const snapshotKey = showAllPackages ? 'all' : 'tracked'
		const hasSnapshot = hasSnapshotRef.current && snapshotKeyRef.current === snapshotKey
		if (inflightRef.current && inflightKeyRef.current === snapshotKey) {
			return inflightRef.current
		}
		const requestId = ++requestIdRef.current
		const task = (async () => {
			setRefreshing(true)
			setInlineError(null)
			if (!hasSnapshot) setPageError(null)
			try {
				const result = await transport.withRpc(async (rpc) => {
					const pkg = rpc.package()
					const [nextInventory, nextIssues] = await Promise.all([
						pkg.inventory({ includeUntracked: showAllPackages }),
						pkg.loadIssues(),
					])
					return { inventory: nextInventory, issues: nextIssues }
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
	}, [transport, showAllPackages])

	useEffect(() => {
		void refetch()
	}, [refetch])

	useEffect(() => {
		return subscribeInvalidations((event) => {
			if (event.topic !== 'package-data') return
			void refetch()
		})
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
	const summaryStats = [
		{ label: '包总数', value: totalPackages },
		{ label: '被引用插件', value: packageConsumers },
		{ label: '运行中的包', value: runningPackages },
		{ label: '存在告警', value: packagesWithIssues, color: packagesWithIssues ? 'red' : undefined },
	]
	const [packageSearch, setPackageSearch] = useState('')
	const deferredPackageSearch = useDeferredValue(packageSearch.trim().toLowerCase())
	const searchActive = deferredPackageSearch.length > 0
	// 搜索过渡状态，用于降低视觉闪烁
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

	// Loading states for RPC operations
	const [installLoading, setInstallLoading] = useState(false)
	const [reinstallLoading, setReinstallLoading] = useState(false)
	const [uninstallLoading, setUninstallLoading] = useState(false)
	const [removeLoading, setRemoveLoading] = useState(false)
	const [reloadBatchLoading, setReloadBatchLoading] = useState(false)
	const [reinstallBatchLoading, setReinstallBatchLoading] = useState(false)
	const [uninstallBatchLoading, setUninstallBatchLoading] = useState(false)
	const [removeBatchLoading, setRemoveBatchLoading] = useState(false)

	const busy =
		installLoading ||
		reinstallLoading ||
		uninstallLoading ||
		removeLoading ||
		reloadBatchLoading ||
		reinstallBatchLoading ||
		uninstallBatchLoading ||
		removeBatchLoading

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
			const result = await transport.withRpc((rpc) =>
				rpc.package().mutate({ action, specs, options }),
			)
			invalidate({ topic: 'package-data', reason: action })
			return result
		},
		[transport],
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
			setLoading: (value: boolean) => void
			options?: { force?: boolean; fresh?: boolean; reinstall?: boolean }
			clearSelection?: boolean
		}) => {
			if (!ensureHasSelection()) return
			const targets = selectedRows.map((row) => row.name)
			openBatchOperationLog(config.logTitle, targets)
			config.setLoading(true)
			try {
				const result = await runPackageMutation(
					config.action,
					selectedRows.map(toSpecInput),
					config.options,
				)
				applyOperationLogs(result)
				summarizeBatchResult(result, config.successTitle, config.fallbackError)
				if (result?.results?.length) {
					await refetch()
				}
				if (config.clearSelection) clearSelection()
			} catch (error: any) {
				markOperationLogsFailed(error?.message)
				notify({
					title: config.errorTitle,
					message: error?.message ?? '操作失败，请稍后再试',
					color: 'red',
				})
			} finally {
				config.setLoading(false)
			}
		},
		[
			applyOperationLogs,
			clearSelection,
			ensureHasSelection,
			markOperationLogsFailed,
			notify,
			openBatchOperationLog,
			refetch,
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
			setLoading: (value: boolean) => void
			successTitle: string
			successMessage: string
			errorTitle: string
			options?: { force?: boolean; fresh?: boolean; reinstall?: boolean }
		}) => {
			const spec = toSpecInput(config.row)
			config.setLoading(true)
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
				await refetch()
			} catch (error: any) {
				notify({
					title: config.errorTitle,
					message: error?.message ?? '操作失败，请稍后再试',
					color: 'red',
				})
			} finally {
				config.setLoading(false)
			}
		},
		[notify, refetch, runPackageMutation],
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
		setInstallLoading(true)

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
		} finally {
			setInstallLoading(false)
			if (successes.length > 0) {
				notify({
					title: '安装完成',
					message: `${summarizeList(successes, 3, '个')} 已完成安装`,
					color: 'green',
				})
				if (successes.length === specs.length) {
					setInstallInput('')
				}
				await refetch()
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
			setLoading: setReloadBatchLoading,
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
			setLoading: setReinstallBatchLoading,
		})
	}

	const handleBatchUninstall = async () => {
		await runSelectedBatchOperation({
			action: 'uninstall',
			logTitle: '卸载包',
			successTitle: '已卸载运行态',
			errorTitle: '卸载失败',
			fallbackError: '卸载失败',
			setLoading: setUninstallBatchLoading,
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
			setLoading: setRemoveBatchLoading,
			clearSelection: true,
		})
	}

	const handleLoad = async (row: PackageRow) => {
		await runRowOperation({
			row,
			action: 'reload',
			setLoading: setReloadBatchLoading,
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
			setLoading: setReinstallLoading,
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
			setLoading: setUninstallLoading,
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
			setLoading: setRemoveLoading,
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

	const renderPackageTable = () => {
		if (filteredRows.length === 0) {
			if (refreshing) {
				return (
					<Box
						p="md"
						style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center' }}
					>
						<Group gap="sm">
							<Loader size="sm" />
							<Text c="dimmed">正在加载包信息…</Text>
						</Group>
					</Box>
				)
			}
			return searchActive ? (
				<EmptyState
					icon={<IconSearchEmpty size={28} stroke={1.5} />}
					title={`没有匹配"${packageSearch.trim()}"的结果`}
					description="尝试其他关键词，或清空搜索条件查看全部包。"
					minHeight={200}
				/>
			) : (
				<EmptyState
					icon={<IconPackages size={28} stroke={1.5} />}
					title="暂无包数据"
					description="可先在上方安装新包，或等待插件上报。"
					minHeight={200}
				/>
			)
		}

		const allVisibleSelected =
			filteredRows.length > 0 && selectedVisibleCount === filteredRows.length
		const isIndeterminate = selectedVisibleCount > 0 && selectedVisibleCount < filteredRows.length

		return (
			<Stack gap="xs" style={{ height: '100%' }}>
				{selectedPackages.size > 0 && (
					<Paper
						withBorder
						radius="md"
						px="sm"
						py={6}
						style={{
							background: 'var(--plx-accent-soft)',
							borderColor: 'var(--plx-selected-border)',
						}}
					>
						<Group gap="sm" align="center" wrap="nowrap">
							<Text size="sm" fw={600} style={{ color: 'var(--plx-accent-strong)' }}>
								已选 {selectedPackages.size} 项
							</Text>
							<Group gap={6}>
								<Tooltip label="重载所选包">
									<ActionIcon
										variant="light"
										color="brand"
										size="md"
										onClick={() => void handleBatchReload(true)}
										loading={reloadBatchLoading}
									>
										<IconRefresh size={18} />
									</ActionIcon>
								</Tooltip>
								<Tooltip label="重装所选包">
									<ActionIcon
										variant="light"
										color="brand"
										size="md"
										loading={reinstallBatchLoading}
										onClick={() => void handleBatchReinstall()}
									>
										<IconRotateClockwise size={18} />
									</ActionIcon>
								</Tooltip>
								<Tooltip label="卸载运行态">
									<ActionIcon
										variant="light"
										color="orange"
										size="md"
										loading={uninstallBatchLoading}
										onClick={() => confirmBatchUninstall()}
									>
										<IconTrash size={18} />
									</ActionIcon>
								</Tooltip>
								<Tooltip label="彻底移除">
									<ActionIcon
										variant="light"
										color="red"
										size="md"
										loading={removeBatchLoading}
										onClick={() => confirmBatchRemove()}
									>
										<IconX size={18} />
									</ActionIcon>
								</Tooltip>
							</Group>
							<ActionIcon
								variant="subtle"
								color="gray"
								size="sm"
								onClick={clearSelection}
								style={{ marginLeft: 'auto' }}
							>
								<IconX size={14} />
							</ActionIcon>
						</Group>
					</Paper>
				)}
				<ScrollArea style={{ flex: 1 }}>
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
								<Table.Th>加载</Table.Th>
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
											onChange={(event) => setRowSelected(row.name, event.currentTarget.checked)}
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
														color="brand"
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
										<Badge variant="light" color="gray">
											{formatSpec(row)}
										</Badge>
									</Table.Td>
									<Table.Td>
										<Badge color={row.loaded ? 'green' : 'gray'} variant="light">
											{row.loaded ? '已加载' : '未加载'}
										</Badge>
									</Table.Td>
									<Table.Td>
										<Text size="sm">
											{row.runningCount}/{row.pluginCount} 运行中
										</Text>
									</Table.Td>
									<Table.Td>
										{row.issues.length > 0 ? (
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
										<Group justify="flex-end" gap={6}>
											{row.loaded ? (
												<Tooltip label="重装">
													<ActionIcon
														variant="light"
														color="brand"
														size="md"
														onClick={() => void performReinstall(row)}
														disabled={busy}
													>
														<IconRotateClockwise size={16} />
													</ActionIcon>
												</Tooltip>
											) : (
												<Tooltip label="加载">
													<ActionIcon
														variant="light"
														color="green"
														size="md"
														onClick={() => void handleLoad(row)}
														disabled={busy}
													>
														<IconRefresh size={16} />
													</ActionIcon>
												</Tooltip>
											)}
											<Tooltip label="卸载运行态">
												<ActionIcon
													variant="light"
													color="orange"
													size="md"
													onClick={() => confirmAndUninstall(row)}
													disabled={busy}
												>
													<IconTrash size={16} />
												</ActionIcon>
											</Tooltip>
											<Tooltip label="彻底移除">
												<ActionIcon
													variant="light"
													color="red"
													size="md"
													onClick={() => confirmAndRemove(row)}
													disabled={busy}
												>
													<IconX size={16} />
												</ActionIcon>
											</Tooltip>
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
			{/* Header */}
			<Group justify="space-between" align="flex-start" wrap="wrap" gap="sm">
				<Stack gap={2} style={{ minWidth: 200 }}>
					<Title order={2}>包管理</Title>
					<Text c="dimmed" size="sm">
						查看已安装的包，快速执行安装、热重装与卸载操作
					</Text>
				</Stack>
				<Group gap="sm">
					{summaryStats.map((stat) => (
						<Paper
							key={stat.label}
							withBorder
							shadow="xs"
							radius="md"
							px="sm"
							py={4}
							style={{ minWidth: 90 }}
						>
							<Text size="xs" c="dimmed">
								{stat.label}
							</Text>
							<Text fw={700} size="md" c={stat.color}>
								{stat.value}
							</Text>
						</Paper>
					))}
					<Checkbox
						label="显示全部依赖"
						checked={showAllPackages}
						onChange={(event) => {
							setShowAllPackages(event.currentTarget.checked)
						}}
						size="sm"
					/>
					<Button
						leftSection={<IconRefresh size={16} />}
						variant="light"
						size="sm"
						onClick={() => void refetch()}
						loading={refreshing && rows.length === 0}
					>
						刷新
					</Button>
				</Group>
			</Group>

			{errorMessage && (
				<Alert color="red" icon={<IconAlertTriangle size={18} />} title="加载失败">
					{errorMessage}
				</Alert>
			)}

			{/* Issues Panel */}
			{sortedIssues.length > 0 && showIssuesPanel && (
				<PackageIssuesPanel
					issues={sortedIssues}
					maxHeight={180}
					onClose={() => setShowIssuesPanel(false)}
				/>
			)}

			{/* Install Card */}
			<Card withBorder shadow="sm" component="form" onSubmit={submitInstall} p="sm">
				<Group align="flex-start" gap="md" wrap="nowrap">
					<Stack gap="xs" style={{ flex: 1 }}>
						<Group gap="xs">
							<Text fw={600} size="sm">
								安装新包
							</Text>
							<Text size="xs" c="dimmed">
								支持 npm 语法，如 name@1.2.3，多个用换行/逗号分隔
							</Text>
						</Group>
						<Textarea
							placeholder="pluxel-plugin-redis&#10;@scope/pkg@1.0.0"
							value={installInput}
							onChange={(event) => setInstallInput(event.currentTarget.value)}
							minRows={2}
							autosize
							maxRows={4}
							style={{ flex: 1 }}
						/>
					</Stack>
					<Stack gap="xs" justify="flex-end" style={{ minWidth: 140 }}>
						{pendingInstallSpecs.length > 0 && (
							<Group gap={4} wrap="wrap">
								{pendingInstallSpecs.slice(0, 3).map((spec) => (
									<Badge key={spec} color="gray" variant="light" size="sm">
										{spec}
									</Badge>
								))}
								{pendingInstallSpecs.length > 3 && (
									<Badge color="gray" variant="light" size="sm">
										+{pendingInstallSpecs.length - 3}
									</Badge>
								)}
							</Group>
						)}
						<Checkbox
							label="强制安装"
							checked={forceInstall}
							onChange={(event) => setForceInstall(event.currentTarget.checked)}
							size="xs"
						/>
						<Button type="submit" loading={installLoading} size="sm">
							{pendingInstallSpecs.length > 1 ? `批量安装 (${pendingInstallSpecs.length})` : '安装'}
						</Button>
					</Stack>
				</Group>
			</Card>

			{/* Package Table */}
			<Card
				withBorder
				shadow="sm"
				style={{
					flex: 1,
					minHeight: 0,
					display: 'flex',
					flexDirection: 'column',
				}}
			>
				<CardSection withBorder px="md" py="xs">
					<Group justify="space-between" align="center" wrap="wrap">
						<Group gap="xs">
							<Title order={5}>已安装的包</Title>
							<Badge variant="light" color="gray">
								{filteredRows.length} / {rows.length}
							</Badge>
						</Group>
						<Group gap="xs">
							<Tooltip
								label={
									<Group gap={4}>
										<Kbd size="xs">Ctrl</Kbd>
										<Text size="xs">+</Text>
										<Kbd size="xs">F</Kbd>
										<Text size="xs">搜索</Text>
									</Group>
								}
								position="bottom"
							>
								<TextInput
									ref={searchInputRef}
									placeholder="搜索包名或插件..."
									leftSection={<IconSearch size={14} />}
									rightSection={
										packageSearch && (
											<ActionIcon size="xs" variant="subtle" onClick={() => setPackageSearch('')}>
												<IconX size={12} />
											</ActionIcon>
										)
									}
									value={packageSearch}
									onChange={(event) => setPackageSearch(event.currentTarget.value)}
									size="sm"
									style={{ minWidth: 240 }}
								/>
							</Tooltip>
							<Tooltip label="查看操作日志">
								<ActionIcon variant="light" color="gray" onClick={() => setOperationLogOpen(true)}>
									<IconTerminal2 size={16} />
								</ActionIcon>
							</Tooltip>
							{!showIssuesPanel && sortedIssues.length > 0 && (
								<Tooltip label="显示告警面板">
									<ActionIcon variant="light" color="red" onClick={() => setShowIssuesPanel(true)}>
										<Badge color="red" size="xs" circle>
											{sortedIssues.length}
										</Badge>
									</ActionIcon>
								</Tooltip>
							)}
						</Group>
					</Group>
				</CardSection>
				<CardSection
					px="md"
					py="sm"
					style={{
						flex: 1,
						minHeight: 0,
						opacity: isSearchTransitioning ? 0.7 : 1,
						transition: 'opacity 100ms ease-out',
					}}
				>
					{renderPackageTable()}
				</CardSection>
			</Card>

			<PackageOperationLogModal
				opened={operationLogOpen}
				onClose={() => setOperationLogOpen(false)}
				title={operationTitle}
				logs={operationLogs}
			/>
		</Stack>
	)
}
