import {
	ActionIcon,
	Badge,
	Box,
	Group,
	Loader,
	Paper,
	Select,
	Stack,
	Text,
	TextInput,
	Tooltip,
} from '@mantine/core'
import { openConfirmModal } from '@mantine/modals'
import {
	formatPluginDefinitionReference,
	formatPluginNodeReference,
	pluginDefinitionIndexKey,
	pluginNodeIndexKey,
} from '@pluxel/core'
import { IconPlus, IconRefresh, IconTopologyStar3, IconTrash } from '@tabler/icons-react'
import type { ElementType, ReactNode } from 'react'
import type { PluginDependencyGraphEdge, PluginDependencyGraphNode } from '@pluxel/runtime/web'
import type {
	PluginDependencyDetail,
	PluginDependencyEndpoint,
	PluginDependent,
} from '../../pluginDependencyGraphSelectors'
import { usePluginDependencyDetail } from '../context'
import { RouterLinkAdapter } from '../../../RouterLinkAdapter'
import { buildPluginGraphEdgeHref } from '../../../plugin-graph/pluginGraphRoute'
import {
	buildConsumerOverrideSelection,
	isConsumerOverrideConfigurable,
	providerAddressDisplayName,
	usePluginDependencyControls,
} from '../usePluginDependencyControls'
import { runtimeErrorMessage } from '../../../../runtime'
import { useNotify } from '../../../hooks/useNotify'

type DetailLinkComponent = ElementType<{
	to: string
	children: ReactNode
	className?: string
	title?: string
	'aria-label'?: string
}>

const VIA_LABEL = {
	'provider-default': '跟随默认',
	'dependency-override': '节点覆盖',
} as const

type RelationBadge = Readonly<{
	label: string
	color: string
	variant?: 'light' | 'outline'
}>

function nodeIssue(node: PluginDependencyGraphNode): RelationBadge | null {
	const status = node.status
	if (status.availability !== 'available') return { label: '不可用', color: 'red' }
	if (status.lifecycleState === 'stopped' && status.desiredState === 'running') {
		return { label: '等待运行', color: 'yellow' }
	}
	if (status.lifecycleState === 'stopped') {
		return { label: '已停止', color: 'gray', variant: 'outline' }
	}
	return null
}

function endpointDisplayName(endpoint: PluginDependencyEndpoint): string {
	return endpoint.state === 'status'
		? endpoint.node.status.displayName
		: endpoint.address.definition.exportName
}

function endpointReference(endpoint: PluginDependencyEndpoint): string {
	return endpoint.state === 'status'
		? endpoint.node.status.reference
		: formatPluginNodeReference(endpoint.address)
}

function endpointBadges(
	endpoint: PluginDependencyEndpoint | null,
	edge: PluginDependencyGraphEdge,
): readonly RelationBadge[] {
	if (!endpoint) return [{ label: '未解析', color: 'red', variant: 'outline' }]
	const badges: RelationBadge[] = []
	if (endpoint.state === 'absent') {
		badges.push({ label: '缺失', color: 'gray', variant: 'outline' })
	} else {
		const issue = nodeIssue(endpoint.node)
		if (issue) badges.push(issue)
		if (!edge.effective) badges.push({ label: '未生效', color: 'gray', variant: 'outline' })
	}

	if (edge.resolution.state === 'resolved' && edge.resolution.via !== 'direct') {
		badges.push({ label: VIA_LABEL[edge.resolution.via], color: 'blue', variant: 'outline' })
	}
	return badges
}

function RelationGraphLink({
	edge,
	label,
	LinkComponent,
}: {
	edge: PluginDependencyGraphEdge
	label: string
	LinkComponent: DetailLinkComponent
}) {
	const canonicalEdge = `${formatPluginNodeReference(edge.consumer)} → ${formatPluginDefinitionReference(edge.requirement)}`
	return (
		<LinkComponent
			to={buildPluginGraphEdgeHref(edge.consumer, edge.requirement)}
			className="plx-pluginDependencyDetail__graphLink"
			aria-label={`在依赖图中定位 ${label}`}
			title={`在依赖图中定位\n${canonicalEdge}`}
		>
			<IconTopologyStar3 size={14} stroke={1.8} aria-hidden="true" />
		</LinkComponent>
	)
}

function RelationRow({
	name,
	reference,
	detailHref,
	badges,
	edge,
	LinkComponent,
	children,
}: {
	name: string
	reference: string
	detailHref?: string
	badges: readonly RelationBadge[]
	edge: PluginDependencyGraphEdge
	LinkComponent: DetailLinkComponent
	children?: ReactNode
}) {
	return (
		<div className="plx-pluginDependencyDetail__relation" role="listitem">
			{detailHref ? (
				<LinkComponent
					to={detailHref}
					className="plx-pluginDependencyDetail__endpointLink"
					title={reference}
				>
					{name}
				</LinkComponent>
			) : (
				<span className="plx-pluginDependencyDetail__endpointName" title={reference}>
					{name}
				</span>
			)}
			<div className="plx-pluginDependencyDetail__relationMeta">
				{badges.map((badge) => (
					<Badge
						key={`${badge.label}:${badge.color}`}
						className="plx-pluginDependencyDetail__badge"
						variant={badge.variant ?? 'light'}
						color={badge.color}
						size="xs"
						radius="sm"
					>
						{badge.label}
					</Badge>
				))}
				<RelationGraphLink edge={edge} label={name} LinkComponent={LinkComponent} />
			</div>
			{children ? (
				<div className="plx-pluginDependencyDetail__implementation">{children}</div>
			) : null}
		</div>
	)
}

function EndpointRelationRow({
	endpoint,
	edge,
	LinkComponent,
	children,
}: {
	endpoint: PluginDependencyEndpoint | null
	edge: PluginDependencyGraphEdge
	LinkComponent: DetailLinkComponent
	children?: ReactNode
}) {
	const name = endpoint ? endpointDisplayName(endpoint) : edge.requirement.exportName
	const reference = endpoint
		? endpointReference(endpoint)
		: formatPluginDefinitionReference(edge.requirement)
	const detailHref =
		endpoint?.state === 'status' ? `/plugins/${endpoint.node.status.route}` : undefined
	return (
		<RelationRow
			name={name}
			reference={reference}
			detailHref={detailHref}
			badges={endpointBadges(endpoint, edge)}
			edge={edge}
			LinkComponent={LinkComponent}
		>
			{children}
		</RelationRow>
	)
}

function RequiredRelations({
	detail,
	LinkComponent,
	controlFor,
}: {
	detail: PluginDependencyDetail
	LinkComponent: DetailLinkComponent
	controlFor?: (dependency: PluginDependencyDetail['required'][number]) => ReactNode
}) {
	return (
		<RelationSection title="必须依赖" count={detail.required.length}>
			{detail.required.map(({ edge, provider }) => (
				<EndpointRelationRow
					key={formatPluginDefinitionReference(edge.requirement)}
					endpoint={provider}
					edge={edge}
					LinkComponent={LinkComponent}
				>
					{controlFor?.({ edge, provider })}
				</EndpointRelationRow>
			))}
		</RelationSection>
	)
}

function OptionalRelations({
	detail,
	LinkComponent,
}: {
	detail: PluginDependencyDetail
	LinkComponent: DetailLinkComponent
}) {
	return (
		<RelationSection title="可选集成" count={detail.optional.length}>
			{detail.optional.map(({ edge, provider }) => (
				<EndpointRelationRow
					key={formatPluginDefinitionReference(edge.requirement)}
					endpoint={provider}
					edge={edge}
					LinkComponent={LinkComponent}
				/>
			))}
		</RelationSection>
	)
}

function DependentRow({
	dependent,
	LinkComponent,
}: {
	dependent: PluginDependent
	LinkComponent: DetailLinkComponent
}) {
	const status = dependent.consumer.status
	const badges: RelationBadge[] = [
		{
			label: dependent.edge.mode === 'required' ? '必须' : '可选',
			color: dependent.edge.mode === 'required' ? 'indigo' : 'cyan',
		},
	]
	const issue = nodeIssue(dependent.consumer)
	if (issue) badges.push(issue)
	if (!dependent.edge.effective) {
		badges.push({ label: '未生效', color: 'gray', variant: 'outline' })
	}
	return (
		<RelationRow
			name={status.displayName}
			reference={status.reference}
			detailHref={`/plugins/${status.route}`}
			badges={badges}
			edge={dependent.edge}
			LinkComponent={LinkComponent}
		/>
	)
}

function Dependents({
	detail,
	LinkComponent,
}: {
	detail: PluginDependencyDetail
	LinkComponent: DetailLinkComponent
}) {
	const { effective, inactive } = detail.dependents
	const summary = [
		effective.length > 0 ? `${effective.length} 生效` : null,
		inactive.length > 0 ? `${inactive.length} 未生效` : null,
	]
		.filter((part): part is string => part !== null)
		.join(' · ')
	const dependents = [...effective, ...inactive]
	return (
		<RelationSection title="被依赖" count={dependents.length} summary={summary || undefined}>
			{dependents.map((dependent) => (
				<DependentRow
					key={`${dependent.consumer.status.reference}:${formatPluginDefinitionReference(dependent.edge.requirement)}`}
					dependent={dependent}
					LinkComponent={LinkComponent}
				/>
			))}
		</RelationSection>
	)
}

function RelationSection({
	title,
	count,
	summary,
	children,
}: {
	title: string
	count: number
	summary?: string
	children: ReactNode
}) {
	return (
		<section className="plx-pluginDependencyDetail__section">
			<div className="plx-pluginDependencyDetail__sectionHeader">
				<Text component="h3" className="plx-pluginDependencyDetail__sectionTitle">
					{title}
					<span className="plx-pluginDependencyDetail__sectionCount">{count}</span>
				</Text>
				{summary ? (
					<span className="plx-pluginDependencyDetail__sectionSummary">{summary}</span>
				) : null}
			</div>
			{count > 0 ? (
				<div className="plx-pluginDependencyDetail__relations" role="list">
					{children}
				</div>
			) : null}
		</section>
	)
}

export function PluginDependencyDetailContent({
	detail,
	LinkComponent,
	requiredControl,
}: {
	detail: PluginDependencyDetail
	LinkComponent: DetailLinkComponent
	requiredControl?: (dependency: PluginDependencyDetail['required'][number]) => ReactNode
}) {
	return (
		<div className="plx-pluginDependencyDetail">
			<RequiredRelations
				detail={detail}
				LinkComponent={LinkComponent}
				controlFor={requiredControl}
			/>
			<OptionalRelations detail={detail} LinkComponent={LinkComponent} />
			<Dependents detail={detail} LinkComponent={LinkComponent} />
		</div>
	)
}

export function PluginDependencyDetailCard() {
	const graph = usePluginDependencyDetail()
	const controls = usePluginDependencyControls()
	const notify = useNotify()
	const renderRequiredControl = (dependency: PluginDependencyDetail['required'][number]) => {
		const key = pluginDefinitionIndexKey(dependency.edge.requirement)
		const row = controls.byRequirement.get(key)
		if (!row || !isConsumerOverrideConfigurable(row)) return null
		return <DependencyImplementationControl row={row} controls={controls} notify={notify} />
	}
	const loading = graph.isLoading || controls.isLoading
	return (
		<Paper withBorder radius="sm" p="sm" shadow="none">
			<Stack gap="sm">
				<Group justify="space-between" align="center" wrap="nowrap">
					<Group gap={6} wrap="wrap">
						<Text size="sm" fw={600}>
							依赖关系
						</Text>
						{graph.isStale ? (
							<Badge variant="outline" color="yellow" size="xs">
								数据待刷新
							</Badge>
						) : null}
					</Group>
					<Tooltip label={loading ? '加载中…' : '刷新依赖关系与候选实现'} withArrow>
						<ActionIcon
							size="sm"
							variant="subtle"
							onClick={() => void controls.refresh()}
							disabled={loading}
							aria-label="刷新依赖关系"
						>
							{loading ? <Loader size={13} /> : <IconRefresh size={14} />}
						</ActionIcon>
					</Tooltip>
				</Group>

				{graph.detail ? (
					<PluginDependencyDetailContent
						detail={graph.detail}
						LinkComponent={RouterLinkAdapter}
						requiredControl={renderRequiredControl}
					/>
				) : graph.isLoading ? (
					<Group gap="xs" wrap="nowrap">
						<Loader size="xs" />
						<Text size="xs" c="dimmed">
							加载依赖关系中…
						</Text>
					</Group>
				) : (
					<Text size="xs" c={graph.error ? 'red' : 'dimmed'}>
						{graph.error ?? '暂无依赖图数据'}
					</Text>
				)}
				{graph.detail && graph.error ? (
					<Text size="xs" c="yellow">
						刷新失败，当前显示上一次成功读取的数据：{graph.error}
					</Text>
				) : null}
				{graph.detail && controls.error ? (
					<Text size="xs" c="yellow">
						候选实现读取失败，关系仍可查看：{controls.error}
					</Text>
				) : null}
			</Stack>
		</Paper>
	)
}

type DependencyControls = ReturnType<typeof usePluginDependencyControls>

function DependencyImplementationControl({
	row,
	controls,
	notify,
}: {
	row: import('../../../../runtime').PluginConsumerRequirementState
	controls: DependencyControls
	notify: ReturnType<typeof useNotify>
}) {
	const consumerOverridePending = controls.isConsumerOverridePending(row.requirement)
	const createPending = controls.isCreateForkPending(row.requirement)
	const selection = buildConsumerOverrideSelection(row)
	const forkOptions = row.options.filter(
		(
			option,
		): option is typeof option & {
			address: Extract<typeof option.address, { variant: 'fork' }>
		} => option.address.variant === 'fork',
	)

	const createFork = () => {
		const base =
			row.options.find((option) => option.address.variant === 'default') ?? row.options[0]
		if (!base) return
		let forkId = ''
		openConfirmModal({
			title: '创建并选择 Fork',
			children: (
				<Box>
					<Text size="sm" c="dimmed">
						从 {base.displayName} 创建当前依赖专用的独立实例；选择后由依赖关系按需启动。
					</Text>
					<TextInput
						autoFocus
						mt="sm"
						label="forkId"
						placeholder="例如：worker-1"
						onChange={(event) => {
							forkId = event.currentTarget.value
						}}
						styles={{ input: { fontFamily: 'var(--mantine-font-monospace)' } }}
					/>
				</Box>
			),
			labels: { confirm: '创建并选择', cancel: '取消' },
			onConfirm: () => {
				void (async () => {
					try {
						const normalized = forkId.trim()
						if (!normalized) throw new Error('forkId 不能为空')
						const result = await controls.createFork(base.address, normalized, row.requirement)
						if (result.ok === false) throw new Error(result.error || result.code || '创建失败')
						const deferred = result.status === 'deferred'
						notify({
							title: 'Fork 已创建并选择',
							message: deferred
								? `${base.displayName} / ${normalized}；当前未运行，将由依赖关系按需启动。`
								: `${base.displayName} / ${normalized}`,
							color: 'green',
						})
					} catch (error) {
						notify({
							title: '创建 Fork 失败',
							message: runtimeErrorMessage(error, '操作失败'),
							color: 'red',
						})
					}
				})()
			},
		})
	}

	return (
		<Stack gap={5}>
			<Group gap={5} wrap="nowrap" align="center">
				<Select
					size="xs"
					aria-label={`设置 ${row.requirement.exportName} 的依赖覆盖`}
					data={selection.data}
					value={selection.value}
					disabled={consumerOverridePending || createPending}
					searchable
					allowDeselect={false}
					comboboxProps={{ withinPortal: true }}
					style={{ flex: 1, minWidth: 0 }}
					nothingFoundMessage="暂无可选实现"
					onChange={(value) => {
						if (!value) return
						const provider = selection.providerFor(value)
						if (provider === undefined) return
						void (async () => {
							try {
								const result = await controls.setConsumerOverride(row.requirement, provider)
								if (result.ok === false) throw new Error(result.error || result.code || '操作失败')
								notify({
									title: '依赖覆盖已更新',
									message: provider
										? providerAddressDisplayName(provider, row.options)
										: '已恢复跟随默认',
									color: 'green',
								})
							} catch (error) {
								notify({
									title: '更新依赖覆盖失败',
									message: runtimeErrorMessage(error, '操作失败'),
									color: 'red',
								})
							}
						})()
					}}
				/>
				<Tooltip label="从现有实现创建 Fork" withArrow>
					<ActionIcon
						size="sm"
						variant="light"
						disabled={consumerOverridePending || createPending || row.options.length === 0}
						onClick={createFork}
						aria-label={`为 ${row.requirement.exportName} 创建 Fork`}
					>
						{createPending ? <Loader size={12} /> : <IconPlus size={14} />}
					</ActionIcon>
				</Tooltip>
			</Group>

			{forkOptions.length > 0 ? (
				<Group gap={5} wrap="wrap">
					{forkOptions.map((option) => {
						const removePending = controls.isRemoveForkPending(option.address)
						return (
							<Group key={pluginNodeIndexKey(option.address)} gap={3} wrap="nowrap">
								<Badge variant="outline" color="gray" radius="sm" size="xs">
									{option.address.forkId}
								</Badge>
								<Tooltip label="删除此 Fork" withArrow>
									<ActionIcon
										size="xs"
										variant="subtle"
										color="red"
										disabled={removePending}
										onClick={() => {
											openConfirmModal({
												title: '删除 Fork',
												children: (
													<Text size="sm" title={formatPluginNodeReference(option.address)}>
														将删除 {option.displayName} / {option.address.forkId}{' '}
														的运行时意图、配置与日志覆盖； 业务数据不会被清理。
													</Text>
												),
												labels: { confirm: '删除', cancel: '取消' },
												confirmProps: { color: 'red' },
												onConfirm: () => {
													void (async () => {
														try {
															const result = await controls.removeFork(option.address)
															if (result.ok === false) {
																const detail =
																	result.code === 'fork_referenced'
																		? `仍被 ${result.references.length} 个依赖覆盖引用，请先清除引用。`
																		: result.error
																throw new Error(detail)
															}
															notify({
																title:
																	result.status === 'already-absent'
																		? 'Fork 已不存在'
																		: result.status === 'removed-with-lifecycle-issues'
																			? 'Fork 已删除，但停止阶段存在问题'
																			: 'Fork 已删除',
																message: `${option.displayName} / ${option.address.forkId}`,
																color:
																	result.status === 'removed-with-lifecycle-issues'
																		? 'yellow'
																		: 'green',
															})
														} catch (error) {
															notify({
																title: '删除 Fork 失败',
																message: runtimeErrorMessage(error, '操作失败'),
																color: 'red',
															})
														}
													})()
												},
											})
										}}
									>
										{removePending ? <Loader size={10} /> : <IconTrash size={12} />}
									</ActionIcon>
								</Tooltip>
							</Group>
						)
					})}
				</Group>
			) : null}
		</Stack>
	)
}
