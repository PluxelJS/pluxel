import {
	Box,
	Button,
	Grid,
	Group,
	Paper,
	Stack,
	Text,
	Title,
	useComputedColorScheme,
} from "@mantine/core"
import {
	IconBolt,
	IconClockPlay,
	IconHistory,
	IconKeyboard,
	IconPackages,
	IconPlugConnected,
	IconShoppingBag,
} from "@tabler/icons-react"
import type { ReactNode } from "react"
import { RouterLinkAdapter } from "../RouterLinkAdapter"
import { getPatternStyle } from "../../theme"

export function HomeIntro({ lastRoute }: { lastRoute: string | null }) {
	const scheme = useComputedColorScheme("light", { getInitialValueInEffect: true })
	const pattern = getPatternStyle(scheme === "dark" ? "dark" : "light")
	const quickActions = buildQuickActions(lastRoute)

	const heroBorder = scheme === "dark" ? "rgba(148,163,184,0.25)" : "rgba(15,23,42,0.08)"
	const heroShadow =
		scheme === "dark" ? "0 30px 80px rgba(2,6,23,0.85)" : "0 20px 60px rgba(15, 23, 42, 0.08)"
	const schemeMode = scheme === "dark" ? "dark" : "light"

	return (
		<Stack gap="lg" p="lg" style={{ height: "100%", minHeight: 0 }}>
			<Paper
				radius="xl"
				withBorder
				style={{
					borderRadius: 32,
					padding: "var(--mantine-spacing-xl)",
					boxShadow: heroShadow,
					border: `1px solid ${heroBorder}`,
					backgroundColor: pattern.backgroundColor,
					backgroundImage: pattern.backgroundImage,
					backgroundSize: pattern.backgroundSize,
					backgroundPosition: pattern.backgroundPosition,
				}}
			>
				<Stack gap="md" maw={720}>
					<Text size="sm" c="dimmed" tt="uppercase" fw={600} letterSpacing={0.6}>
						欢迎回来
					</Text>
					<Title order={2} fw={700}>
						继续构建你的插件宇宙
					</Title>
					<Text c="dimmed">
						Pluxel 控制台会记住你的工作位置。以下入口可帮助你迅速恢复节奏、跳转到常用工作区。
					</Text>
					<Group gap="sm" mt="xs">
						<Button component={RouterLinkAdapter} to="/plugins">
							打开插件工作台
						</Button>
						<Button component={RouterLinkAdapter} to="/packages" variant="light">
							前往包管理
						</Button>
					</Group>
				</Stack>
				<Group gap="sm" mt="xl" align="stretch">
					{quickActions.map((action) => (
						<Paper
							key={action.title}
							withBorder={false}
							radius="lg"
							p="md"
							style={{
								flex: "1 1 220px",
								display: "flex",
								flexDirection: "column",
								gap: 12,
								backgroundColor: scheme === "dark" ? "rgba(2,6,23,0.85)" : "rgba(255,255,255,0.92)",
								border: `1px solid ${
									scheme === "dark" ? "rgba(148,163,184,0.2)" : "rgba(15,23,42,0.08)"
								}`,
							}}
						>
							<Group justify="space-between" align="flex-start">
								<div>
									<Text fw={600}>{action.title}</Text>
									<Text size="sm" c={scheme === "dark" ? "gray.4" : "dimmed"}>
										{action.description}
									</Text>
								</div>
								<Box
									style={{
										width: 32,
										height: 32,
										borderRadius: "50%",
										background:
											scheme === "dark" ? "rgba(99,102,241,0.25)" : "rgba(99,102,241,0.12)",
										display: "flex",
										alignItems: "center",
										justifyContent: "center",
									}}
								>
									{action.icon}
								</Box>
							</Group>
							<Button
								component={RouterLinkAdapter}
								to={action.to}
								variant="light"
								size="xs"
								radius="md"
								mt="auto"
							>
								立刻进入
							</Button>
						</Paper>
					))}
				</Group>
			</Paper>

			<Grid gutter="lg">
				<Grid.Col span={{ base: 12, md: 4 }}>
					<HomeCard
						title="插件工作台"
						description="以分组和搜索快速定位插件，并实时查看运行状态。"
						icon={<IconPlugConnected size={24} stroke={1.6} />}
						to="/plugins"
						scheme={schemeMode}
					/>
				</Grid.Col>
				<Grid.Col span={{ base: 12, md: 4 }}>
					<HomeCard
						title="包管理"
						description="管理依赖、查看版本和同步安装状态。"
						icon={<IconPackages size={24} stroke={1.6} />}
						to="/packages"
						scheme={schemeMode}
					/>
				</Grid.Col>
				<Grid.Col span={{ base: 12, md: 4 }}>
					<HomeCard
						title="插件市场"
						description="浏览官方快照，快速安装插件。"
						icon={<IconShoppingBag size={24} stroke={1.6} />}
						to="/market"
						scheme={schemeMode}
					/>
				</Grid.Col>
				<Grid.Col span={{ base: 12, md: 4 }}>
					<HomeCard
						title="实时日志"
						description="监控最新日志事件，把脉系统健康度。"
						icon={<IconHistory size={24} stroke={1.6} />}
						to="/logs"
						scheme={schemeMode}
					/>
				</Grid.Col>
				<Grid.Col span={{ base: 12, md: 4 }}>
					<HomeCard
						title="快捷键提示"
						description="记住 / 或 Ctrl/⌘ + F 可随时唤起插件搜索。"
						icon={<IconKeyboard size={24} stroke={1.6} />}
						to="/plugins"
						scheme={schemeMode}
					/>
				</Grid.Col>
				<Grid.Col span={{ base: 12, md: 4 }}>
					<HomeCard
						title="快照与构建"
						description="在顶部工具栏可快速触发快照构建，保存当前状态。"
						icon={<IconBolt size={24} stroke={1.6} />}
						to="/plugins"
						scheme={schemeMode}
					/>
				</Grid.Col>
			</Grid>
		</Stack>
	)
}

interface QuickAction {
	title: string
	description: string
	to: string
	icon: ReactNode
}

function buildQuickActions(lastRoute: string | null): QuickAction[] {
	const actions: Array<QuickAction | null> = [
		createResumeAction(lastRoute),
		{
			title: "浏览插件",
			description: "打开分组与运行状态面板",
			to: "/plugins",
			icon: <IconPlugConnected size={20} stroke={1.6} />,
		},
		{
			title: "前往插件市场",
			description: "挑选新插件并一键安装",
			to: "/market",
			icon: <IconShoppingBag size={20} stroke={1.6} />,
		},
		{
			title: "查看实时日志",
			description: "即时洞察最新输出",
			to: "/logs",
			icon: <IconHistory size={20} stroke={1.6} />,
		},
	]
	return actions.filter(Boolean) as QuickAction[]
}

function createResumeAction(lastRoute: string | null): QuickAction | null {
	if (!lastRoute) return null
	if (lastRoute.startsWith("/plugins/")) {
		const raw = lastRoute.replace("/plugins/", "")
		try {
			const decoded = decodeURIComponent(raw)
			return {
				title: "继续上次工作",
				description: `继续查看「${decoded}」`,
				to: lastRoute,
				icon: <IconClockPlay size={20} stroke={1.6} />,
			}
		} catch {
			return {
				title: "继续上次工作",
				description: "快速返回刚才的插件详情",
				to: lastRoute,
				icon: <IconClockPlay size={20} stroke={1.6} />,
			}
		}
	}

	const map: Record<string, QuickAction> = {
		"/plugins": {
			title: "继续上次工作",
			description: "返回插件工作台",
			to: "/plugins",
			icon: <IconPlugConnected size={20} stroke={1.6} />,
		},
		"/packages": {
			title: "继续上次工作",
			description: "回到包管理",
			to: "/packages",
			icon: <IconPackages size={20} stroke={1.6} />,
		},
		"/logs": {
			title: "继续上次工作",
			description: "回到实时日志",
			to: "/logs",
			icon: <IconHistory size={20} stroke={1.6} />,
		},
	}

	return map[lastRoute] ?? null
}

function HomeCard({
	title,
	description,
	to,
	icon,
	scheme,
}: {
	title: string
	description: string
	to: string
	icon: ReactNode
	scheme: "light" | "dark"
}) {
	const isDark = scheme === "dark"
	return (
		<Button
			component={RouterLinkAdapter}
			to={to}
			variant="default"
			radius="lg"
			style={{
				width: "100%",
				height: "100%",
				display: "flex",
				alignItems: "flex-start",
				justifyContent: "space-between",
				flexDirection: "column",
				textAlign: "left",
				padding: "var(--mantine-spacing-lg)",
				backgroundColor: isDark ? "rgba(2,6,23,0.85)" : "rgba(255,255,255,0.92)",
				border: isDark ? "1px solid rgba(148,163,184,0.25)" : "1px solid rgba(15,23,42,0.08)",
				color: isDark ? "var(--mantine-color-gray-0)" : undefined,
			}}
		>
			<div>
				<Title order={4}>{title}</Title>
				<Text c={isDark ? "gray.4" : "dimmed"} size="sm" mt={4}>
					{description}
				</Text>
			</div>
			<Group gap={8} align="center">
				{icon}
				<Text size="sm" fw={600}>
					进入 →
				</Text>
			</Group>
		</Button>
	)
}
