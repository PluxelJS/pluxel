import { createHomeLayout } from 'fumapress/layouts/home'
import { Link } from 'fumapress/client'

const HomeLayout = createHomeLayout()

const paths = [
	{
		description: '一页完成 package、配置、实现、宿主启用和 lifecycle test。',
		href: '/docs/getting-started',
		title: '1. 写出第一个 Plugin',
	},
	{
		description: '掌握依赖图、配置、generation、effects、失败传播与宿主边界。',
		href: '/docs/getting-started/plugin-model',
		title: '2. 理解核心模型',
	},
	{
		description: '在 static 与 dynamic route 中二选一，把 Plugin 装进可运行宿主。',
		href: '/docs/getting-started/host-setup',
		title: '3. 配置宿主',
	},
	{
		description: '只选择当前需要的 HTTP、数据库、worker、Commands 或 Workbench 专题。',
		href: '/docs#按任务进入',
		title: '4. 按需增加能力',
	},
]

export default function HomePage() {
	return (
		<HomeLayout>
			<div className="mx-auto flex w-full max-w-6xl flex-1 flex-col px-6 py-20 sm:py-28">
				<section className="max-w-3xl">
					<p className="mb-4 text-sm font-medium text-fd-primary">Pluxel Documentation</p>
					<h1 className="text-balance text-4xl font-semibold tracking-tight sm:text-6xl">
						把插件写成可验证、可组合的能力单元
					</h1>
					<p className="mt-6 max-w-2xl text-pretty text-lg leading-8 text-fd-muted-foreground">
						从第一个可运行 Plugin 到生产宿主，渐进理解依赖图、配置、生命周期、运行时能力与
						Workbench。
					</p>
					<div className="mt-8 flex flex-wrap gap-3">
						<Link
							className="rounded-lg bg-fd-primary px-5 py-2.5 font-medium text-fd-primary-foreground"
							href="/docs"
						>
							开始阅读
						</Link>
						<Link
							className="rounded-lg border bg-fd-card px-5 py-2.5 font-medium hover:bg-fd-accent"
							href="/playground"
						>
							打开配置 Playground
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
