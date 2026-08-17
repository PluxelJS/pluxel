import { createHomeLayout } from 'fumapress/layouts/home'
import { Link } from 'fumapress/client'

const HomeLayout = createHomeLayout()

const paths = [
	{
		description: '了解项目与 Cordis、Koishi 的渊源，以及依赖身份、Context 和动态分派的设计取舍。',
		href: '/docs/why-pluxel',
		title: '为什么是 Pluxel',
	},
	{
		description: '一页完成插件包、配置、实现、宿主启用和生命周期测试。',
		href: '/docs/getting-started',
		title: '编写第一个 Plugin',
	},
	{
		description: '掌握必需依赖、可选集成、版本代际、资源回收与失败传播。',
		href: '/docs/getting-started/plugin-model',
		title: '理解 Plugin 模型',
	},
	{
		description: '用一份 Valibot schema 统一类型、默认值、校验和管理界面。',
		href: '/docs/getting-started/configuration',
		title: '定义配置',
	},
	{
		description: '在静态与动态模式中选择一种，把 Plugin 装进可运行的宿主。',
		href: '/docs/getting-started/host-setup',
		title: '配置宿主',
	},
	{
		description: '按当前任务查找 HTTP、数据库、缓存、Worker、Commands 或 Workbench。',
		href: '/docs#按任务进入',
		title: '按需增加能力',
	},
]

export default function HomePage() {
	return (
		<HomeLayout>
			<div className="mx-auto flex w-full max-w-6xl flex-1 flex-col px-6 py-20 sm:py-28">
				<section className="max-w-3xl">
					<p className="mb-4 text-sm font-medium text-fd-primary">Pluxel 文档</p>
					<h1 className="text-balance text-4xl font-semibold tracking-tight sm:text-6xl">
						把插件写成可验证、可组合的能力单元
					</h1>
					<p className="mt-6 max-w-2xl text-pretty text-lg leading-8 text-fd-muted-foreground">
						从第一个可运行的 Plugin 开始，逐步掌握依赖、配置、生命周期、宿主与运行时能力。
					</p>
					<div className="mt-8 flex flex-wrap gap-3">
						<Link
							className="rounded-lg bg-fd-primary px-5 py-2.5 font-medium text-fd-primary-foreground"
							href="/docs/getting-started"
						>
							编写第一个 Plugin
						</Link>
						<Link
							className="rounded-lg border bg-fd-card px-5 py-2.5 font-medium hover:bg-fd-accent"
							href="/docs/why-pluxel"
						>
							为什么是 Pluxel
						</Link>
					</div>
				</section>

				<section className="mt-20 grid gap-4 md:grid-cols-2">
					{paths.map((item) => (
						<Link
							key={item.href}
							className="rounded-xl border bg-fd-card p-6 transition-colors hover:bg-fd-accent"
							href={item.href}
						>
							<h2 className="font-semibold">{item.title}</h2>
							<p className="mt-2 text-sm leading-6 text-fd-muted-foreground">{item.description}</p>
						</Link>
					))}
				</section>
			</div>
		</HomeLayout>
	)
}
