import {
	ActionIcon,
	Alert,
	Badge,
	Box,
	Button,
	Center,
	Group,
	Loader,
	Paper,
	SegmentedControl,
	Stack,
	Text,
	TextInput,
	Tooltip,
} from '@mantine/core'
import {
	IconAlertTriangle,
	IconArrowRight,
	IconRefresh,
	IconSearch,
	IconX,
} from '@tabler/icons-react'
import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import { formatPluginDefinitionReference } from '@pluxel/core'
import { EmptyState, ErrorState } from '../../components'
import { RouterLinkAdapter } from '../router/RouterLinkAdapter'
import { usePluginDependencyGraph } from '../plugins/pluginDependencyGraph'
import {
	buildPluginGraphVisualModel,
	describePluginGraphNode,
	pluginGraphSelectionKey,
	rebasePluginGraphSelection,
	resolvePluginGraphFocus,
	searchPluginGraphNodes,
	type ManualPluginGraphSelection,
	type PluginGraphModeFilter,
	type PluginGraphSelection,
	type PluginGraphVisualModel,
	type PluginGraphView,
} from './pluginGraphModel'
import { parsePluginGraphFocus } from './pluginGraphRoute'

const PluginGraphRenderer = lazy(() =>
	import('./PluginGraphRenderer').then((module) => ({ default: module.PluginGraphRenderer })),
)

const VIEW_OPTIONS = [
	{ value: 'effective', label: '有效图' },
	{ value: 'declaration', label: '声明关系' },
]

const MODE_OPTIONS = [
	{ value: 'all', label: '全部' },
	{ value: 'required', label: '必须依赖' },
	{ value: 'optional', label: '可选集成' },
]

export function PluginGraphScreen({ pathname }: { pathname: string }) {
	const graphState = usePluginDependencyGraph()
	const [view, setView] = useState<PluginGraphView>('effective')
	const [mode, setMode] = useState<PluginGraphModeFilter>('all')
	const [search, setSearch] = useState('')
	const [manualSelectionKey, setManualSelectionKey] =
		useState<ManualPluginGraphSelection>(undefined)
	const model = useMemo(
		() => (graphState.graph ? buildPluginGraphVisualModel(graphState.graph, view, mode) : null),
		[graphState.graph, mode, view],
	)
	const routeFocus = useMemo(() => parsePluginGraphFocus(pathname), [pathname])
	const routeSelection = useMemo(
		() => (model ? resolvePluginGraphFocus(model, routeFocus) : null),
		[model, routeFocus],
	)
	const rebasedSelection = useMemo(
		() => (model ? rebasePluginGraphSelection(model, manualSelectionKey, routeSelection) : null),
		[manualSelectionKey, model, routeSelection],
	)
	const selection = rebasedSelection?.selection ?? null
	const searchResults = useMemo(
		() => (model && search.trim() ? searchPluginGraphNodes(model, search).slice(0, 8) : []),
		[model, search],
	)

	useEffect(() => {
		setManualSelectionKey(undefined)
	}, [pathname])

	useEffect(() => {
		if (rebasedSelection && rebasedSelection.manualSelectionKey !== manualSelectionKey) {
			setManualSelectionKey(rebasedSelection.manualSelectionKey)
		}
	}, [manualSelectionKey, rebasedSelection])

	useEffect(() => {
		if (!graphState.graph || !routeFocus || routeSelection) return
		const declarationModel = buildPluginGraphVisualModel(graphState.graph, 'declaration', 'all')
		if (!resolvePluginGraphFocus(declarationModel, routeFocus)) return
		if (view !== 'declaration') setView('declaration')
		if (mode !== 'all') setMode('all')
	}, [graphState.graph, mode, routeFocus, routeSelection, view])

	if (!graphState.hasSnapshot && graphState.isLoading) {
		return (
			<Center className="plx-pluginGraphState">
				<Stack gap="xs" align="center">
					<Loader size="sm" />
					<Text c="dimmed" size="sm">
						加载依赖图…
					</Text>
				</Stack>
			</Center>
		)
	}

	if (!graphState.hasSnapshot || !model) {
		return (
			<ErrorState
				title="依赖图不可用"
				message={graphState.error ?? 'Runtime 没有返回可用的依赖图 snapshot。'}
				onRetry={() => void graphState.refetch()}
				minHeight="100%"
			/>
		)
	}

	return (
		<div className="plx-pluginGraphPage">
			<Paper withBorder radius="sm" p="sm" className="plx-pluginGraphToolbar">
				<Group justify="space-between" align="flex-start" wrap="wrap" gap="sm">
					<Stack gap={4}>
						<Group gap="xs" wrap="wrap">
							<Text fw={650}>Plugin 依赖图</Text>
							<Badge variant="light" color="gray">
								{model.nodes.length} 个节点 · {model.edges.length} 条关系
							</Badge>
							{graphState.isStale ? (
								<Badge variant="outline" color="yellow">
									数据待刷新
								</Badge>
							) : null}
						</Group>
						<Text size="xs" c="dimmed">
							从提供方指向使用方；必须依赖为实线，可选集成为虚线。
						</Text>
					</Stack>
					<Group gap="xs" wrap="wrap">
						<SegmentedControl
							size="xs"
							aria-label="依赖图视图"
							data={VIEW_OPTIONS}
							value={view}
							onChange={(value) => {
								setView(value as PluginGraphView)
								setManualSelectionKey(undefined)
							}}
						/>
						<SegmentedControl
							size="xs"
							aria-label="依赖关系类型筛选"
							data={MODE_OPTIONS}
							value={mode}
							onChange={(value) => {
								setMode(value as PluginGraphModeFilter)
								setManualSelectionKey(undefined)
							}}
						/>
						<Tooltip label={graphState.isLoading ? '刷新中…' : '刷新依赖数据'}>
							<ActionIcon
								variant="default"
								onClick={() => void graphState.refetch()}
								disabled={graphState.isLoading}
								aria-label="刷新依赖图"
							>
								{graphState.isLoading ? <Loader size={14} /> : <IconRefresh size={16} />}
							</ActionIcon>
						</Tooltip>
					</Group>
				</Group>
				<Box className="plx-pluginGraphSearch">
					<TextInput
						value={search}
						onChange={(event) => setSearch(event.currentTarget.value)}
						leftSection={<IconSearch size={15} />}
						placeholder="搜索 Plugin 名称或标准引用"
						aria-label="搜索依赖图节点"
					/>
					{searchResults.length > 0 ? (
						<Paper withBorder shadow="md" className="plx-pluginGraphSearch__results">
							{searchResults.map((node) => (
								<Button
									key={node.id}
									variant="subtle"
									color="gray"
									fullWidth
									justify="space-between"
									onClick={() => {
										setManualSelectionKey({ kind: 'node', id: node.id })
										setSearch('')
									}}
								>
									<span>{node.label}</span>
									<Text component="span" size="xs" c="dimmed" truncate>
										{node.reference}
									</Text>
								</Button>
							))}
						</Paper>
					) : null}
				</Box>
			</Paper>

			{graphState.error ? (
				<Alert color="yellow" icon={<IconAlertTriangle size={17} />}>
					刷新失败，当前显示上一次成功读取的数据：{graphState.error}
				</Alert>
			) : null}

			{model.nodes.length === 0 ? (
				<EmptyState
					title="当前筛选没有节点"
					description="切换到声明关系或调整 relation filter 后重试。"
					minHeight={320}
				/>
			) : (
				<div className="plx-pluginGraphWorkspace" data-has-selection={selection ? 'true' : 'false'}>
					<Suspense
						fallback={
							<Center className="plx-pluginGraphCanvas" role="status">
								<Loader size="sm" />
							</Center>
						}
					>
						<PluginGraphRenderer
							model={model}
							selection={selection}
							onSelect={(nextSelection) =>
								setManualSelectionKey(pluginGraphSelectionKey(nextSelection))
							}
						/>
					</Suspense>
					{selection ? (
						<PluginGraphInspector
							selection={selection}
							model={model}
							onSelect={(nextSelection) =>
								setManualSelectionKey(pluginGraphSelectionKey(nextSelection))
							}
							onClose={() => setManualSelectionKey(null)}
						/>
					) : null}
				</div>
			)}
		</div>
	)
}

function PluginGraphInspector({
	selection,
	model,
	onSelect,
	onClose,
}: {
	selection: PluginGraphSelection
	model: PluginGraphVisualModel
	onSelect: (selection: PluginGraphSelection) => void
	onClose: () => void
}) {
	if (selection.kind === 'edge') {
		const edge = selection.edge
		const provider = model.byId.get(edge.source)
		const consumer = model.byId.get(edge.target)
		return (
			<InspectorShell title="依赖关系" onClose={onClose}>
				<InspectorRelation label={provider?.label ?? 'Unknown provider'} node={provider} />
				<Center>
					<IconArrowRight size={18} aria-label="provider 到 consumer" />
				</Center>
				<InspectorRelation label={consumer?.label ?? 'Unknown consumer'} node={consumer} />
				<Stack gap={4}>
					<Text size="xs" c="dimmed">
						依赖声明
					</Text>
					<Text size="xs" ff="monospace" style={{ overflowWrap: 'anywhere' }}>
						{formatPluginDefinitionReference(edge.edge.requirement)}
					</Text>
				</Stack>
				<Group gap="xs">
					<Badge color={edge.mode === 'required' ? 'indigo' : 'cyan'}>
						{edge.mode === 'required' ? '必须依赖' : '可选集成'}
					</Badge>
					<Badge variant="outline" color={edge.effective ? 'blue' : 'gray'}>
						{edge.effective ? '当前生效' : '仅声明'}
					</Badge>
				</Group>
				{edge.edge.resolution.state === 'resolved' ? (
					<Text size="xs" c="dimmed">
						解析方式：{resolutionLabel(edge.edge.resolution.via)}
					</Text>
				) : (
					<Text size="xs" c="red">
						尚未选择 provider
					</Text>
				)}
			</InspectorShell>
		)
	}

	const visual = selection.node
	const dependencies = model.incomingById.get(visual.id) ?? []
	const dependents = model.outgoingById.get(visual.id) ?? []
	const status = visual.kind === 'plugin' ? pluginNodeStatus(visual) : null
	const runtimeStatus = visual.kind === 'plugin' ? visual.node.status : null
	return (
		<InspectorShell title={visual.label} onClose={onClose}>
			<Text size="xs" ff="monospace" style={{ overflowWrap: 'anywhere' }}>
				{visual.reference}
			</Text>
			{visual.kind === 'plugin' ? (
				<>
					<Group gap="xs" wrap="wrap">
						<Badge color={status?.color ?? 'gray'}>{status?.label}</Badge>
						<Badge variant="outline">{visual.effective ? '当前生效' : '仅声明'}</Badge>
						<Badge variant="outline" color={runtimeStatus?.autoStart ? 'blue' : 'gray'}>
							{runtimeStatus?.autoStart ? '自动启动' : '按需启动'}
						</Badge>
						<Badge
							variant="outline"
							color={runtimeStatus?.desiredState === 'running' ? 'teal' : 'gray'}
						>
							期望{runtimeStatus?.desiredState === 'running' ? '运行' : '停止'}
						</Badge>
					</Group>
					<Text size="sm">
						依赖 {dependencies.length} · 被依赖 {dependents.length}
					</Text>
					<InspectorEdgeList title="依赖" edges={dependencies} model={model} onSelect={onSelect} />
					<InspectorEdgeList title="被依赖" edges={dependents} model={model} onSelect={onSelect} />
					{visual.node.status.issues.map((issue) => (
						<Alert key={issue.id} color="yellow" icon={<IconAlertTriangle size={15} />}>
							<Text size="xs">{issue.message}</Text>
						</Alert>
					))}
					<Button
						component={RouterLinkAdapter}
						to={`/plugins/${visual.node.status.route}`}
						variant="light"
						size="xs"
					>
						打开 Plugin 详情
					</Button>
				</>
			) : (
				<Alert color="gray">该节点只存在于浏览器声明视图，不会写入 catalog 或持久状态。</Alert>
			)}
		</InspectorShell>
	)
}

function pluginNodeStatus(
	visual: Extract<PluginGraphVisualModel['nodes'][number], { kind: 'plugin' }>,
): { label: string; color: string } {
	const presentation = describePluginGraphNode(visual)
	const color =
		presentation.state === 'running'
			? 'green'
			: presentation.state === 'attention'
				? 'yellow'
				: presentation.state === 'unavailable' || presentation.state === 'missing'
					? 'red'
					: 'gray'
	return { label: presentation.stateLabel, color }
}

function resolutionLabel(via: 'direct' | 'provider-default' | 'dependency-override'): string {
	return via === 'direct'
		? '默认实例'
		: via === 'provider-default'
			? '跟随全局默认'
			: '当前插件指定'
}

function InspectorShell({
	title,
	onClose,
	children,
}: {
	title: string
	onClose: () => void
	children: React.ReactNode
}) {
	return (
		<Paper
			component="aside"
			withBorder
			radius="sm"
			p="sm"
			className="plx-pluginGraphInspector"
			aria-label={`依赖图检查器：${title}`}
		>
			<Group justify="space-between" wrap="nowrap">
				<Text fw={650}>{title}</Text>
				<ActionIcon variant="subtle" onClick={onClose} aria-label="关闭 graph inspector">
					<IconX size={16} />
				</ActionIcon>
			</Group>
			<Stack gap="sm" mt="sm">
				{children}
			</Stack>
		</Paper>
	)
}

function InspectorRelation({
	label,
	node,
}: {
	label: string
	node?: PluginGraphVisualModel['nodes'][number]
}) {
	return (
		<Paper withBorder radius="sm" p="xs">
			<Text size="sm" fw={600}>
				{label}
			</Text>
			{node?.kind === 'plugin' ? (
				<RouterLinkAdapter
					to={`/plugins/${node.node.status.route}`}
					className="plx-pluginGraphInspector__detailLink"
				>
					打开 Plugin 详情
				</RouterLinkAdapter>
			) : null}
		</Paper>
	)
}

function InspectorEdgeList({
	title,
	edges,
	model,
	onSelect,
}: {
	title: string
	edges: PluginGraphVisualModel['edges']
	model: PluginGraphVisualModel
	onSelect: (selection: PluginGraphSelection) => void
}) {
	return (
		<Stack gap={4}>
			<Text size="xs" c="dimmed" fw={600}>
				{title}
			</Text>
			{edges.length === 0 ? (
				<Text size="xs" c="dimmed">
					无
				</Text>
			) : (
				edges.map((edge) => {
					const provider = model.byId.get(edge.source)
					const consumer = model.byId.get(edge.target)
					return (
						<Button
							key={edge.id}
							variant="subtle"
							color="gray"
							size="compact-xs"
							justify="flex-start"
							onClick={() => onSelect({ kind: 'edge', edge })}
						>
							{provider?.label ?? 'Unknown provider'} → {consumer?.label ?? 'Unknown consumer'}
						</Button>
					)
				})
			)}
		</Stack>
	)
}
