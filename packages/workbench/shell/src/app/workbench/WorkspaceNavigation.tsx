import {
	ActionIcon,
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
import { IconArrowUpRight, IconCopy, IconSearch } from '@tabler/icons-react'
import { useMemo, useState } from 'react'
import type { WorkbenchLayoutEntry } from '@pluxel/workbench/client'
import { buildPluginDetailHref } from '../../workbench/paths'
import { getWorkbenchDirectoryHref } from '../../workbench/route-directory'
import { matchWorkbenchRoute } from '../../workbench/routes'
import { useWorkbenchTargetSnapshot } from '../../workbench/runtime'
import { useWorkbenchNavigation } from './context'

const builtinPages = [
	{ href: '/', label: '首页', description: '运行状态与常用操作' },
	{ href: '/plugins', label: '插件', description: '插件目录与配置' },
	{ href: '/logs', label: '日志', description: '实时日志' },
	{ href: '/security', label: '认证与安全', description: '用户、权限与凭据' },
	{ href: '/security/audit', label: '安全审计', description: '访问与操作记录' },
	{ href: '/plugin-graph', label: '依赖图', description: '插件依赖与运行拓扑' },
] as const

/** Publication categories organize discovery; native TabGroups remain user-owned layout. */
export function WorkspaceNavigation({
	onChosen,
	autofocus = false,
	onShowNavigation,
}: {
	onChosen?: () => void
	autofocus?: boolean
	onShowNavigation?: () => void
}) {
	const navigation = useWorkbenchNavigation()
	const snapshot = useWorkbenchTargetSnapshot(null)
	const [query, setQuery] = useState('')
	const [routeEntry, setRouteEntry] = useState<WorkbenchLayoutEntry>()
	const [routePath, setRoutePath] = useState('')
	const [newInstance, setNewInstance] = useState(false)
	const needle = query.trim().toLocaleLowerCase()
	const matches = (text: string) => !needle || text.toLocaleLowerCase().includes(needle)
	const entries = useMemo(
		() =>
			[...(snapshot.layout?.entries ?? [])].sort((left, right) => {
				const leftOrder = left.placement.order ?? 0
				const rightOrder = right.placement.order ?? 0
				return (
					leftOrder - rightOrder || left.target.displayName.localeCompare(right.target.displayName)
				)
			}),
		[snapshot.layout],
	)
	const open = (href: string, copy = false, title?: string) => {
		if (copy) navigation.openTab({ path: href, title: title ?? href })
		else navigation.navigate(href)
		onChosen?.()
	}
	const openEntry = (entry: WorkbenchLayoutEntry, copy = false) => {
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
	const visibleBuiltins = builtinPages.filter((page) =>
		matches(`${page.label} ${page.href} ${page.description}`),
	)
	const visibleEntries = entries.filter((entry) =>
		matches(
			`${entry.target.displayName} ${entry.descriptor.key} ${entry.placement.kind === 'tab' ? `${entry.placement.group?.label ?? ''} ${entry.placement.label ?? ''}` : `${entry.placement.navigation?.group?.label ?? ''} ${entry.placement.title} ${entry.placement.path}`}`,
		),
	)
	const showTool = Boolean(onShowNavigation && matches('入口导航 固定工具 navigation'))
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
		<div className="plx-workspace-navigation">
			<TextInput
				aria-label="查找工作区入口"
				placeholder="查找页面或插件入口"
				leftSection={<IconSearch size={15} />}
				value={query}
				onChange={(event) => setQuery(event.currentTarget.value)}
				autoFocus={autofocus}
				data-autofocus={autofocus || undefined}
				size="xs"
				onKeyDown={(event) => {
					if (event.key === 'Enter') {
						if (showTool) openTool()
						else if (visibleBuiltins[0]) open(visibleBuiltins[0].href)
						else if (visibleEntries[0]) openEntry(visibleEntries[0])
					} else if (event.key === 'Escape' && query) {
						event.preventDefault()
						event.stopPropagation()
						setQuery('')
					}
				}}
			/>
			<ScrollArea className="plx-workspace-navigation__scroll" type="auto" offsetScrollbars>
				<Stack gap="md" pr={4}>
					{showTool && (
						<Stack gap={3}>
							<Text size="xs" c="dimmed" fw={600}>
								固定工具
							</Text>
							<NavigationItem
								label="入口导航"
								description="显示或重新打开工作区入口工具"
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
									onOpen={() => open(page.href)}
									onCopy={() => open(page.href, true, page.label)}
								/>
							))}
						</Stack>
					)}
					{snapshot.state === 'loading' && (
						<Text size="xs" role="status" c="dimmed">
							正在读取插件入口…
						</Text>
					)}
					{snapshot.error && (
						<Alert color="red" title="插件入口读取失败">
							{snapshot.error.message}
						</Alert>
					)}
					{visibleEntries.length > 0 && (
						<Stack gap={3}>
							<Text size="xs" c="dimmed" fw={600}>
								插件页面 · {visibleEntries.length}
							</Text>
							{visibleEntries.map((entry) => {
								const placement = entry.placement
								const label =
									placement.kind === 'tab'
										? (placement.label ?? entry.descriptor.key)
										: placement.title
								const standalone = placement.kind === 'route' && placement.frame === 'standalone'
								const description = [
									entry.target.displayName,
									placement.kind === 'tab'
										? placement.group?.label
										: placement.navigation?.group?.label,
									standalone ? '独立页面' : null,
								]
									.filter(Boolean)
									.join(' · ')
								return (
									<NavigationItem
										key={`${buildPluginDetailHref(entry.target.node)}:${entry.descriptor.key}`}
										label={label}
										description={description}
										onOpen={() => openEntry(entry)}
										onCopy={standalone ? undefined : () => openEntry(entry, true)}
										standalone={standalone}
									/>
								)
							})}
						</Stack>
					)}
					{visibleBuiltins.length === 0 && visibleEntries.length === 0 && !showTool && (
						<Text c="dimmed" size="sm">
							没有匹配的入口
						</Text>
					)}
				</Stack>
			</ScrollArea>
			<Text size="xs" c="dimmed">
				单击复用文档；副本按钮打开独立实例。
			</Text>
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
	onCopy,
	standalone = false,
}: {
	label: string
	description: string
	onOpen(): void
	onCopy?: () => void
	standalone?: boolean
}) {
	return (
		<Group gap={2} wrap="nowrap" className="plx-workspace-navigation__item">
			<Button
				variant="subtle"
				justify="start"
				className="plx-workspace-navigation__link"
				onClick={onOpen}
				rightSection={standalone ? <IconArrowUpRight size={14} aria-hidden /> : undefined}
			>
				<span>
					<Text component="span" size="sm" truncate="end" display="block">
						{label}
					</Text>
					<Text component="span" size="xs" c="dimmed" truncate="end" display="block">
						{description}
					</Text>
				</span>
			</Button>
			{onCopy && (
				<Tooltip label="在新标签打开副本">
					<ActionIcon
						variant="subtle"
						size="sm"
						aria-label={`${label}：在新标签打开副本`}
						onClick={onCopy}
					>
						<IconCopy size={14} />
					</ActionIcon>
				</Tooltip>
			)}
		</Group>
	)
}
