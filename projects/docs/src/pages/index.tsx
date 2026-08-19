import { Link } from 'fumapress/client'
import { createHomeLayout } from 'fumapress/layouts/home'
import {
	ArrowRight,
	Boxes,
	Braces,
	CircleDot,
	CloudCog,
	GitBranch,
	Gauge,
	PackageCheck,
	RefreshCw,
	ServerCog,
	Settings2,
	Workflow,
} from 'lucide-react'
import { PluginShowcase } from '../components/plugin-showcase'

const HomeLayout = createHomeLayout()

const stages = [
	{
		description: '构造函数中的依赖直接成为类型约束，不再另写一份运行时声明。',
		href: '/docs/getting-started/plugin-model',
		icon: Braces,
		title: '从 TypeScript 读取依赖',
	},
	{
		description: '构建阶段生成静态描述，缺失依赖和循环在启动前就能暴露。',
		href: '/docs/development/tooling',
		icon: GitBranch,
		title: '构建可检查的 Plugin 图',
	},
	{
		description: 'Runtime 按代际发布服务；重载、失败和资源清理遵循同一套生命周期。',
		href: '/docs/getting-started/plugin-model',
		icon: RefreshCw,
		title: '让变更完整地生效',
	},
]

const hosts = [
	{
		description: 'Plugin 清单随应用构建，适合固定部署、审计和可复现发行。开发期仍支持 HMR。',
		icon: ServerCog,
		meta: 'Fixed catalog',
		title: 'Static host',
	},
	{
		description: '运行期间增加或删除 Plugin 文件入口，适合由配置和 package source 驱动的宿主。',
		icon: CloudCog,
		meta: 'Mutable sources',
		title: 'Dynamic host',
	},
]

const pluginPaths = [
	{
		description: '带宿主出站策略的原生 Wretch client。',
		href: '/docs/plugins/wretch',
		icon: Workflow,
		meta: '@pluxel/wretch',
		title: 'HTTP client',
	},
	{
		description: '服务端字体、Canvas 与 ECharts 图片渲染。',
		href: '/docs/plugins/rendering',
		icon: Gauge,
		meta: 'Fonts · Canvas · ECharts',
		title: '服务端渲染',
	},
	{
		description: '隔离缓存、Redis、对象存储与频率控制。',
		href: '/docs/plugins/cache',
		icon: PackageCheck,
		meta: 'Workspace integrations',
		title: '数据与基础设施',
	},
	{
		description: '用一份 Valibot schema 生成类型、校验和管理表单。',
		href: '/docs/getting-started/configuration',
		icon: Settings2,
		meta: 'Schema-driven',
		title: '配置与 Workbench',
	},
]

export default function HomePage() {
	return (
		<HomeLayout>
			<main className="pluxel-home">
				<section className="pluxel-hero">
					<div className="pluxel-hero-copy">
						<p className="pluxel-kicker">
							<CircleDot aria-hidden="true" /> TypeScript Plugin Runtime
						</p>
						<h1>Pluxel</h1>
						<p className="pluxel-hero-lead">
							用构造函数表达依赖，由构建工具生成 Plugin 图，再由 Runtime 负责启动、更新与资源回收。
						</p>
						<div className="pluxel-hero-actions">
							<Link className="pluxel-primary-action" href="/docs/getting-started">
								开始编写 <ArrowRight aria-hidden="true" />
							</Link>
							<Link className="pluxel-secondary-action" href="/docs/why-pluxel">
								为什么需要 Pluxel
							</Link>
						</div>
					</div>

					<PluginShowcase />
				</section>

				<section className="pluxel-stage-section" aria-labelledby="runtime-model">
					<div className="pluxel-section-heading">
						<p className="pluxel-kicker"><Boxes aria-hidden="true" /> 一套模型贯穿构建与运行</p>
						<h2 id="runtime-model">依赖关系不止用来决定启动顺序</h2>
					</div>
					<div className="pluxel-stages">
						{stages.map((stage, index) => {
							const Icon = stage.icon
							return (
								<Link key={stage.title} href={stage.href} className="pluxel-stage">
									<div className="pluxel-stage-index">0{index + 1}</div>
									<Icon aria-hidden="true" />
									<h3>{stage.title}</h3>
									<p>{stage.description}</p>
									<span className="pluxel-card-link">阅读文档 <ArrowRight aria-hidden="true" /></span>
								</Link>
							)
						})}
					</div>
				</section>

				<section className="pluxel-docs-section" aria-labelledby="choose-host">
					<div className="pluxel-section-heading">
						<p className="pluxel-kicker"><ServerCog aria-hidden="true" /> 两种宿主，共享一套 Plugin API</p>
						<h2 id="choose-host">按部署方式选择 Runtime</h2>
					</div>
					<div className="pluxel-host-cards">
						{hosts.map((host) => {
							const Icon = host.icon
							return (
								<Link key={host.title} href="/docs/getting-started/host-setup" className="pluxel-doc-card">
									<Icon aria-hidden="true" />
									<span className="pluxel-card-meta">{host.meta}</span>
									<h3>{host.title}</h3>
									<p>{host.description}</p>
									<span className="pluxel-card-link">配置宿主 <ArrowRight aria-hidden="true" /></span>
								</Link>
							)
						})}
					</div>
				</section>

				<section className="pluxel-docs-section pluxel-plugin-section" aria-labelledby="official-plugins">
					<div className="pluxel-section-heading">
						<p className="pluxel-kicker"><PackageCheck aria-hidden="true" /> 按需安装，不挤进核心</p>
						<h2 id="official-plugins">从任务进入官方 Plugin</h2>
						<p>公开 package 与工作区集成分开标注，文档说明真实边界和当前可用状态。</p>
					</div>
					<div className="pluxel-plugin-cards">
						{pluginPaths.map((item) => {
							const Icon = item.icon
							return (
								<Link key={item.title} href={item.href} className="pluxel-doc-card">
									<Icon aria-hidden="true" />
									<span className="pluxel-card-meta">{item.meta}</span>
									<h3>{item.title}</h3>
									<p>{item.description}</p>
									<span className="pluxel-card-link">查看能力 <ArrowRight aria-hidden="true" /></span>
								</Link>
							)
						})}
					</div>
				</section>
			</main>
		</HomeLayout>
	)
}
