import { Button, Group, Paper, SimpleGrid, Stack, Text, ThemeIcon, Title } from '@mantine/core'
import {
	IconArrowRight,
	IconBolt,
	IconClockPlay,
	IconHistory,
	IconKeyboard,
	IconPackages,
	IconPlugConnected,
	IconShieldCheck,
} from '@tabler/icons-react'
import type { ReactNode } from 'react'
import { RouterLinkAdapter } from '../RouterLinkAdapter'

type WorkspaceLink = {
	title: string
	description: string
	to: string
	icon: ReactNode
	meta: string
}

const WORKSPACE_LINKS: WorkspaceLink[] = [
	{
		title: '插件工作台',
		description: '查看运行状态、配置与依赖关系',
		to: '/plugins',
		icon: <IconPlugConnected size={20} stroke={1.7} />,
		meta: '管理',
	},
	{
		title: '包管理',
		description: '安装依赖并处理版本与加载问题',
		to: '/packages',
		icon: <IconPackages size={20} stroke={1.7} />,
		meta: '依赖',
	},
	{
		title: '实时日志',
		description: '按级别筛选并追踪最新运行事件',
		to: '/logs',
		icon: <IconHistory size={20} stroke={1.7} />,
		meta: '诊断',
	},
	{
		title: '安全中心',
		description: '检查管理访问与近期安全事件',
		to: '/security',
		icon: <IconShieldCheck size={20} stroke={1.7} />,
		meta: '审计',
	},
]

export function HomeIntro({ lastRoute }: { lastRoute: string | null }) {
	const resume = createResumeAction(lastRoute)

	return (
		<main className="plx-home">
			<section className="plx-home__hero" aria-labelledby="plx-home-title">
				<div className="plx-home__heroCopy">
					<Text className="plx-home__eyebrow">Runtime control center</Text>
					<Title id="plx-home-title" order={1} className="plx-home__title">
						管理插件，定位问题，继续工作。
					</Title>
					<Text className="plx-home__description">
						这里是 Pluxel 的运行控制台。常用操作集中在一屏内，减少寻找入口和来回跳转。
					</Text>
					<Group gap="sm" className="plx-home__heroActions">
						<Button
							component={RouterLinkAdapter}
							to={resume?.to ?? '/plugins'}
							leftSection={resume ? <IconClockPlay size={17} /> : <IconPlugConnected size={17} />}
						>
							{resume?.title ?? '打开插件工作台'}
						</Button>
						<Button component={RouterLinkAdapter} to="/logs" variant="default">
							查看实时日志
						</Button>
					</Group>
				</div>

				<div className="plx-home__heroSummary" aria-label="控制台说明">
					<div className="plx-home__summaryMark" aria-hidden="true">
						<IconBolt size={22} stroke={1.7} />
					</div>
					<div>
						<Text fw={700}>面向日常运维</Text>
						<Text size="sm" c="dimmed">
							状态、配置、依赖与日志在同一个工作台内完成。
						</Text>
					</div>
				</div>
			</section>

			<div className="plx-home__contentGrid">
				<section aria-labelledby="plx-home-tools-title">
					<div className="plx-home__sectionHeader">
						<div>
							<Text className="plx-home__sectionKicker">工作区</Text>
							<Title id="plx-home-tools-title" order={2} className="plx-home__sectionTitle">
								常用工具
							</Title>
						</div>
						<Text size="sm" c="dimmed">
							4 个核心入口
						</Text>
					</div>

					<SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
						{WORKSPACE_LINKS.map((item) => (
							<WorkspaceCard key={item.to} {...item} />
						))}
					</SimpleGrid>
				</section>

				<aside className="plx-home__aside" aria-labelledby="plx-home-guide-title">
					<div className="plx-home__sectionHeader">
						<div>
							<Text className="plx-home__sectionKicker">效率</Text>
							<Title id="plx-home-guide-title" order={2} className="plx-home__sectionTitle">
								快速操作
							</Title>
						</div>
					</div>

					<Stack gap={0} className="plx-home__guideList">
						<GuideRow
							icon={<IconKeyboard size={18} />}
							title="打开插件搜索"
							description="按 / 或 Ctrl/⌘ + F"
						/>
						<GuideRow
							icon={<IconClockPlay size={18} />}
							title="恢复工作位置"
							description={resume?.description ?? '打开过的页面会自动保留'}
						/>
						<GuideRow
							icon={<IconShieldCheck size={18} />}
							title="先检查再变更"
							description="敏感操作可在安全中心审计"
						/>
					</Stack>
				</aside>
			</div>
		</main>
	)
}

function WorkspaceCard({ title, description, to, icon, meta }: WorkspaceLink) {
	return (
		<Paper
			component={RouterLinkAdapter as any}
			to={to}
			className="plx-home__workspaceCard"
			withBorder
			radius="md"
			p={0}
		>
			<div className="plx-home__workspaceIcon">{icon}</div>
			<div className="plx-home__workspaceCopy">
				<Group justify="space-between" gap="sm" wrap="nowrap">
					<Text fw={700}>{title}</Text>
					<Text className="plx-home__workspaceMeta">{meta}</Text>
				</Group>
				<Text size="sm" c="dimmed">
					{description}
				</Text>
			</div>
			<IconArrowRight className="plx-home__workspaceArrow" size={18} aria-hidden="true" />
		</Paper>
	)
}

function GuideRow({
	icon,
	title,
	description,
}: {
	icon: ReactNode
	title: string
	description: string
}) {
	return (
		<div className="plx-home__guideRow">
			<ThemeIcon variant="light" size={34} radius="md">
				{icon}
			</ThemeIcon>
			<div>
				<Text size="sm" fw={700}>
					{title}
				</Text>
				<Text size="xs" c="dimmed">
					{description}
				</Text>
			</div>
		</div>
	)
}

function createResumeAction(lastRoute: string | null) {
	if (!lastRoute || lastRoute === '/') return null
	if (lastRoute.startsWith('/plugins/')) {
		const raw = lastRoute.replace('/plugins/', '')
		let name = '上次打开的插件'
		try {
			name = `插件「${decodeURIComponent(raw)}」`
		} catch {}
		return { title: '继续上次工作', description: `返回${name}`, to: lastRoute }
	}

	const map: Record<string, { title: string; description: string; to: string }> = {
		'/plugins': { title: '继续上次工作', description: '返回插件工作台', to: '/plugins' },
		'/packages': { title: '继续上次工作', description: '返回包管理', to: '/packages' },
		'/logs': { title: '继续上次工作', description: '返回实时日志', to: '/logs' },
		'/security': { title: '继续上次工作', description: '返回安全中心', to: '/security' },
	}

	return map[lastRoute] ?? null
}
