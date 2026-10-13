import {
	Alert,
	Button,
	Group,
	Modal,
	ScrollArea,
	Stack,
	Text,
	TextInput,
	Tooltip,
} from '@mantine/core'
import { IconArrowUpRight, IconChevronRight, IconSearch } from '@tabler/icons-react'
import { useMemo, useState, type ReactNode } from 'react'
import { formatPluginNodeRoute } from '@pluxel/core'
import type { WorkbenchLayoutEntry } from '@pluxel/workbench/client'
import { buildPluginDetailHref } from '../../workbench/paths'
import { getWorkbenchDirectoryHref } from '../../workbench/route-directory'
import { matchWorkbenchRoute } from '../../workbench/routes'
import { useWorkbenchTargetSnapshot } from '../../workbench/runtime'
import { usePluginOverview } from '../plugins/pluginOverview'
import { useWorkbenchNavigation } from './context'

import { builtinPages } from './navigationItems'

type PageEntry = WorkbenchLayoutEntry & {
	placement: Exclude<WorkbenchLayoutEntry['placement'], { kind: 'panel' }>
}

/** Publication categories organize discovery; native TabGroups remain user-owned layout. */
export function WorkspaceNavigation({
	onChosen,
	autofocus = false,
	onShowNavigation,
	mode = 'all',
	openMode = 'reuse',
	activePluginRoute,
	activeEntryKey,
}: {
	mode?: 'plugins' | 'publications' | 'all'
	openMode?: 'reuse' | 'new'
	activePluginRoute?: string | null
	activeEntryKey?: string
	onChosen?: () => void
	autofocus?: boolean
	onShowNavigation?: () => void
}) {
	const navigation = useWorkbenchNavigation()
	const snapshot = useWorkbenchTargetSnapshot(null)
	const plugins = usePluginOverview()
	const [query, setQuery] = useState('')
	const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
	const compact = mode !== 'all' || openMode === 'new'
	const toggleGroup = (key: string) =>
		setCollapsed((previous) => {
			const next = new Set(previous)
			if (next.has(key)) next.delete(key)
			else next.add(key)
			return next
		})
	const [routeEntry, setRouteEntry] = useState<PageEntry>()
	const [routePath, setRoutePath] = useState('')
	const [newInstance, setNewInstance] = useState(false)
	const needle = query.trim().toLocaleLowerCase()
	const matches = (text: string) => !needle || text.toLocaleLowerCase().includes(needle)
	const entries = useMemo(
		() =>
			[...(snapshot.layout?.entries ?? [])]
				.filter((entry): entry is PageEntry => entry.placement.kind !== 'panel')
				.sort((left, right) => {
					const leftOrder = left.placement.order ?? 0
					const rightOrder = right.placement.order ?? 0
					return (
						leftOrder - rightOrder ||
						left.target.displayName.localeCompare(right.target.displayName)
					)
				}),
		[snapshot.layout],
	)
	const open = (href: string, copy = openMode === 'new', title?: string) => {
		if (copy) navigation.openTab({ path: href, title: title ?? href })
		else navigation.navigate(href)
		onChosen?.()
	}
	const openEntry = (entry: PageEntry, copy = openMode === 'new') => {
		if (entry.placement.kind === 'route' && entry.placement.frame === 'standalone') copy = false
		if (entry.placement.kind === 'tab') {
			open(
				`${buildPluginDetailHref(entry.target.node)}?entry=${encodeURIComponent(entry.descriptor.key)}`,
				copy,
				entry.placement.label ?? entry.descriptor.key,
			)
			return
		}
		const route = snapshot.directory.routes.find((candidate) => candidate.entry === entry)
		if (route?.compiled.segments.some((segment) => segment.parameter)) {
			setRouteEntry(entry)
			setRoutePath(entry.placement.path)
			setNewInstance(copy)
			return
		}
		open(
			getWorkbenchDirectoryHref(snapshot.directory, entry.target.node, entry.placement.path),
			copy,
			entry.placement.title,
		)
	}
	const visiblePlugins = (
		mode !== 'publications' && openMode !== 'new' ? (plugins.overview?.status.statuses ?? []) : []
	).filter((plugin) => matches(`${plugin.label} ${plugin.route}`))
	const pluginGroups = [
		{ key: 'running', label: '运行中' },
		{ key: 'stopped', label: '已停止' },
		{ key: 'unavailable', label: '不可用' },
	]
		.map((group) => ({
			key: group.key,
			label: group.label,
			entries: visiblePlugins
				.filter(
					(plugin) =>
						(plugin.availability === 'unavailable' ? 'unavailable' : plugin.lifecycleState) ===
						group.key,
				)
				.sort(
					(left, right) =>
						left.label.localeCompare(right.label) || left.route.localeCompare(right.route),
				),
		}))
		.filter((group) => group.entries.length > 0)
	const visibleBuiltins = (mode === 'all' ? builtinPages : []).filter((page) =>
		matches(`${page.label} ${page.href} ${page.description}`),
	)
	const visibleEntries = entries.filter(
		(entry) =>
			mode !== 'plugins' &&
			(mode === 'all' || entry.placement.kind === 'tab' || Boolean(entry.placement.navigation)) &&
			matches(
				`${entry.target.displayName} ${entry.descriptor.key} ${entry.placement.kind === 'tab' ? `${entry.placement.group?.label ?? ''} ${entry.placement.label ?? ''}` : `${entry.placement.navigation?.group?.label ?? ''} ${entry.placement.navigation?.label ?? ''} ${entry.placement.title} ${entry.placement.path}`}`,
			),
	)
	const showTool = Boolean(
		mode === 'all' &&
		openMode === 'reuse' &&
		onShowNavigation &&
		matches('插件目录 固定工具 navigation'),
	)
	const publicationGroups = new Map<
		string,
		{ label: string; explicit: boolean; entries: PageEntry[] }
	>()
	for (const entry of visibleEntries) {
		const group =
			entry.placement.kind === 'tab' ? entry.placement.group : entry.placement.navigation?.group
		const key = JSON.stringify([buildPluginDetailHref(entry.target.node), group?.id ?? null])
		let section = publicationGroups.get(key)
		if (!section) {
			section = {
				label: [entry.target.displayName, group?.label].filter(Boolean).join(' · '),
				explicit: !!group,
				entries: [],
			}
			publicationGroups.set(key, section)
		}
		section.entries.push(entry)
	}
	const openTool = () => {
		onShowNavigation?.()
		onChosen?.()
	}
	const selectedRoute = snapshot.directory.routes.find(
		(candidate) => candidate.entry === routeEntry,
	)
	let concreteLocation: URL | undefined
	if (
		selectedRoute &&
		routePath.startsWith('/') &&
		!routePath.startsWith('//') &&
		routePath !== selectedRoute.compiled.path
	) {
		const candidate = new URL(routePath, 'https://workbench.invalid')
		const params = matchWorkbenchRoute(selectedRoute.compiled, candidate.pathname)
		if (
			candidate.origin === 'https://workbench.invalid' &&
			params &&
			Object.entries(params).every(([name, value]) => value !== `:${name}`)
		)
			concreteLocation = candidate
	}
	return (
		<div className="plx-workspace-navigation" data-compact={compact || undefined}>
			<div className="plx-workspace-navigation__search">
				<TextInput
					aria-label="查找工作区入口"
					placeholder={
						mode === 'plugins'
							? '查找插件'
							: mode === 'publications'
								? '查找应用'
								: '查找页面或插件入口'
					}
					leftSection={<IconSearch size={15} />}
					value={query}
					onChange={(event) => setQuery(event.currentTarget.value)}
					autoFocus={autofocus}
					data-autofocus={autofocus || undefined}
					size="xs"
					onKeyDown={(event) => {
						if (event.key === 'Enter') {
							if (showTool) openTool()
							else if (visibleBuiltins[0])
								open(visibleBuiltins[0].href, openMode === 'new', visibleBuiltins[0].label)
							else if (pluginGroups[0]?.entries[0])
								open(buildPluginDetailHref(pluginGroups[0].entries[0].address))
							else if (visibleEntries[0]) openEntry(visibleEntries[0])
						} else if (event.key === 'Escape' && query) {
							event.preventDefault()
							event.stopPropagation()
							setQuery('')
						}
					}}
				/>
				{mode === 'plugins' && (
					<Button
						size="compact-xs"
						variant="subtle"
						className="plx-workspace-navigation__manage"
						onClick={() => open('/plugins')}
					>
						插件管理
					</Button>
				)}
			</div>
			<ScrollArea className="plx-workspace-navigation__scroll" type="auto" offsetScrollbars>
				<Stack gap={compact ? 4 : 'md'} pr={0}>
					{showTool && (
						<Stack gap={3}>
							<Text size="xs" c="dimmed" fw={600}>
								固定工具
							</Text>
							<NavigationItem
								label="插件目录"
								description="显示或重新打开插件目录"
								onOpen={openTool}
							/>
						</Stack>
					)}
					{visibleBuiltins.length > 0 && (
						<Stack gap={3}>
							<Text size="xs" c="dimmed" fw={600}>
								工作台
							</Text>
							{visibleBuiltins.map((page) => (
								<NavigationItem
									key={page.href}
									label={page.label}
									description={page.description}
									onOpen={() => open(page.href, openMode === 'new', page.label)}
								/>
							))}
						</Stack>
					)}
					{mode !== 'publications' && openMode !== 'new' && plugins.error && (
						<Alert color="red" title="插件列表读取失败">
							{plugins.error}
						</Alert>
					)}
					{mode !== 'publications' && openMode !== 'new' && plugins.isLoading && (
						<Text size="xs" role="status" c="dimmed">
							正在读取插件目录…
						</Text>
					)}
					{pluginGroups.map((group) => (
						<NavigationGroup
							key={group.key}
							label={group.label}
							count={group.entries.length}
							compact={compact}
							expanded={Boolean(needle) || !collapsed.has(group.key)}
							onToggle={() => toggleGroup(group.key)}
						>
							{group.entries.map((plugin) => {
								const failure = plugin.issues?.find((issue) =>
									[
										'resolve-failed',
										'config-failed',
										'start-failed',
										'dependency-blocked',
										'drain-failed',
									].includes(issue.code),
								)
								const pending =
									plugin.desiredState === 'running' &&
									plugin.lifecycleState !== 'running' &&
									plugin.availability !== 'unavailable'
								const status = failure
									? failure.code === 'dependency-blocked'
										? '依赖阻塞'
										: '运行异常'
									: pending
										? '等待启动'
										: group.label
								return (
									<NavigationItem
										key={plugin.route}
										label={plugin.label}
										description={status}
										compact={compact}
										detail={`${plugin.label}
${plugin.route}
${status}${failure ? ` · ${failure.message}` : ''}`}
										statusTone={
											failure || plugin.availability === 'unavailable'
												? 'error'
												: pending
													? 'pending'
													: plugin.lifecycleState
										}
										statusLabel={status}
										attention={
											failure || pending || plugin.availability === 'unavailable'
												? status
												: undefined
										}
										active={activePluginRoute === plugin.route}
										onOpen={() => open(buildPluginDetailHref(plugin.address))}
									/>
								)
							})}
						</NavigationGroup>
					))}
					{mode !== 'plugins' && snapshot.state === 'loading' && (
						<Text size="xs" role="status" c="dimmed">
							正在读取应用入口…
						</Text>
					)}
					{mode !== 'plugins' && snapshot.error && (
						<Alert color="red" title="应用入口读取失败">
							{snapshot.error.message}
						</Alert>
					)}
					{[...publicationGroups].map(([key, group]) => (
						<NavigationGroup
							key={key}
							hideHeading={
								(mode === 'publications' || openMode === 'new') &&
								!group.explicit &&
								group.entries.length === 1
							}
							label={group.label}
							count={group.entries.length}
							compact={compact}
							expanded={Boolean(needle) || !collapsed.has(key)}
							onToggle={() => toggleGroup(key)}
						>
							{group.entries.map((entry) => {
								const placement = entry.placement
								const label =
									placement.kind === 'tab'
										? (placement.label ?? entry.descriptor.key)
										: (placement.navigation?.label ?? placement.title)
								const standalone = placement.kind === 'route' && placement.frame === 'standalone'
								return (
									<NavigationItem
										key={`${buildPluginDetailHref(entry.target.node)}:${entry.descriptor.key}`}
										label={label}
										compact={compact}
										detail={`${label}
${group.label}
${placement.kind === 'route' ? placement.path : entry.descriptor.key}${standalone ? '\n独立页面' : ''}`}
										description={
											standalone
												? '独立页面'
												: placement.kind === 'tab'
													? '插件工作页'
													: placement.title
										}
										active={
											activePluginRoute === formatPluginNodeRoute(entry.target.node) &&
											activeEntryKey === entry.descriptor.key
										}
										onOpen={() => openEntry(entry)}
										standalone={standalone}
									/>
								)
							})}
						</NavigationGroup>
					))}
					{visibleBuiltins.length === 0 &&
						visiblePlugins.length === 0 &&
						visibleEntries.length === 0 &&
						!showTool && (
							<Text c="dimmed" size="sm">
								没有匹配的入口
							</Text>
						)}
				</Stack>
			</ScrollArea>
			{!compact && (
				<Text size="xs" c="dimmed">
					选择入口，打开或切换到已有页面。
				</Text>
			)}
			<Modal
				opened={Boolean(routeEntry)}
				onClose={() => setRouteEntry(undefined)}
				title="输入具体页面路径"
				size="sm"
				centered
			>
				<Stack gap="sm">
					<Text size="sm" c="dimmed">
						将路径中的参数替换为实际值。此入口仍使用插件声明的路由和认证。
					</Text>
					<TextInput
						label="页面路径"
						description={selectedRoute?.compiled.path}
						value={routePath}
						onChange={(event) => setRoutePath(event.currentTarget.value)}
						data-autofocus
					/>
					<Button
						disabled={!concreteLocation}
						onClick={() => {
							if (!routeEntry || routeEntry.placement.kind !== 'route' || !concreteLocation) return
							const href = getWorkbenchDirectoryHref(
								snapshot.directory,
								routeEntry.target.node,
								concreteLocation.pathname,
								routeEntry.placement.frame,
							)
							open(
								href + concreteLocation.search + concreteLocation.hash,
								newInstance,
								routeEntry.placement.title,
							)
							setRouteEntry(undefined)
						}}
					>
						打开页面
					</Button>
				</Stack>
			</Modal>
		</div>
	)
}

function NavigationItem({
	label,
	description,
	onOpen,
	standalone = false,
	active = false,
	compact = false,
	detail,
	statusTone,
	statusLabel,
	attention,
}: {
	label: string
	description: string
	onOpen(): void
	standalone?: boolean
	active?: boolean
	compact?: boolean
	detail?: string
	statusTone?: string
	statusLabel?: string
	attention?: string
}) {
	return (
		<Group gap={2} wrap="nowrap" className="plx-workspace-navigation__item">
			<Tooltip
				label={detail ?? `${label} · ${description}`}
				multiline
				maw={420}
				openDelay={400}
				disabled={!compact}
				events={{ hover: true, focus: true, touch: false }}
			>
				<Button
					title={detail ?? `${label} · ${description}`}
					aria-label={
						compact
							? [label, statusLabel, standalone ? '独立页面' : undefined]
									.filter(Boolean)
									.join(' · ')
							: undefined
					}
					leftSection={
						compact && statusTone ? (
							<span
								className="plx-workspace-navigation__status"
								data-tone={statusTone}
								aria-hidden
							/>
						) : undefined
					}
					variant={active ? 'light' : 'subtle'}
					aria-current={active ? 'page' : undefined}
					justify="start"
					className="plx-workspace-navigation__link"
					onClick={onOpen}
					rightSection={standalone ? <IconArrowUpRight size={14} aria-hidden /> : undefined}
				>
					<span>
						<Text component="span" size="sm" truncate="end" display="block">
							{label}
						</Text>
						{!compact && (
							<Text component="span" size="xs" c="dimmed" truncate="end" display="block">
								{description}
							</Text>
						)}
					</span>
				</Button>
			</Tooltip>
			{compact && attention && (
				<span className="plx-workspace-navigation__attention" data-tone={statusTone}>
					{attention}
				</span>
			)}
		</Group>
	)
}

function NavigationGroup({
	hideHeading = false,
	label,
	count,
	compact,
	expanded,
	onToggle,
	children,
}: {
	label: string
	hideHeading?: boolean
	count: number
	compact: boolean
	expanded: boolean
	onToggle(): void
	children: ReactNode
}) {
	return (
		<section role="group" aria-label={label} className="plx-workspace-navigation__group">
			{hideHeading ? null : compact ? (
				<button
					type="button"
					className="plx-workspace-navigation__group-heading"
					aria-expanded={expanded}
					onClick={onToggle}
					title={label}
				>
					<IconChevronRight size={12} className="plx-workspace-navigation__chevron" aria-hidden />
					<span className="plx-workspace-navigation__group-label">{label}</span>
					<span className="plx-workspace-navigation__count">{count}</span>
				</button>
			) : (
				<Text size="xs" c="dimmed" fw={600}>
					{label} · {count}
				</Text>
			)}
			<div hidden={!hideHeading && compact && !expanded} className="plx-workspace-navigation__rows">
				{children}
			</div>
		</section>
	)
}
