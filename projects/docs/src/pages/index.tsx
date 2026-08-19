import { Link } from 'fumapress/client'
import { createHomeLayout } from 'fumapress/layouts/home'
import {
	ArrowRight,
	Boxes,
	Braces,
	CircleDot,
	CloudCog,
	Gauge,
	PackageCheck,
	ServerCog,
	Settings2,
	Workflow,
} from 'lucide-react'
import { PluginShowcase } from '../components/plugin-showcase'

const HomeLayout = createHomeLayout()

const patterns = [
	{
		code: 'constructor(private http: WretchPlugin) { super() }',
		description: '需要另一个 Plugin 时，直接写构造函数参数。类型就是依赖声明。',
		href: '/docs/getting-started/plugin-model',
		icon: Braces,
		title: '注入依赖',
	},
	{
		code: 'private config = this.configs.use(StatusConfig)',
		description: '读取经过默认值和校验的冻结配置，不再维护平行的 TypeScript interface。',
		href: '/docs/getting-started/configuration',
		icon: Settings2,
		title: '读取配置',
	},
	{
		code: 'this.ctx.effects.defer(() => clearInterval(timer))',
		description: '创建资源后立即登记释放函数；停止、替换和启动回滚都会执行。',
		href: '/docs/getting-started/plugin-model',
		icon: Boxes,
		title: '登记清理',
	},
]

const hosts = [
	{
		code: `defineStaticRuntime({
  plugins: [OrdersPlugin],
})`,
		description: 'Plugin 清单随应用构建，适合固定部署、审计和可复现发行。开发期仍支持 HMR。',
		icon: ServerCog,
		meta: 'Fixed catalog',
		title: 'Static host',
	},
	{
		code: `defineDynamicRuntimeConfig({
  plugins: [HostOperationsPlugin],
})`,
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
							写一个 class，用构造函数注入能力；配置、HTTP route 和资源清理都放在固定位置，开发期直接热更新。
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

				<section className="pluxel-stage-section" aria-labelledby="writing-patterns">
					<div className="pluxel-section-heading">
						<p className="pluxel-kicker"><Braces aria-hidden="true" /> 直接看日常写法</p>
						<h2 id="writing-patterns">写 Plugin 最常用的三个位置</h2>
					</div>
					<div className="pluxel-stages">
						{patterns.map((pattern, index) => {
							const Icon = pattern.icon
							return (
								<Link key={pattern.title} href={pattern.href} className="pluxel-stage">
									<div className="pluxel-stage-index">0{index + 1}</div>
									<Icon aria-hidden="true" />
									<h3>{pattern.title}</h3>
									<code className="pluxel-pattern-code">{pattern.code}</code>
									<p>{pattern.description}</p>
									<span className="pluxel-card-link">阅读文档 <ArrowRight aria-hidden="true" /></span>
								</Link>
							)
						})}
					</div>
				</section>

				<section className="pluxel-docs-section" aria-labelledby="choose-host">
					<div className="pluxel-section-heading">
						<p className="pluxel-kicker"><ServerCog aria-hidden="true" /> 最后放进宿主</p>
						<h2 id="choose-host">Plugin 写法不随宿主改变</h2>
					</div>
					<div className="pluxel-host-cards">
						{hosts.map((host) => {
							const Icon = host.icon
							return (
								<Link key={host.title} href="/docs/getting-started/host-setup" className="pluxel-doc-card">
									<Icon aria-hidden="true" />
									<span className="pluxel-card-meta">{host.meta}</span>
									<h3>{host.title}</h3>
									<pre className="pluxel-host-code"><code>{host.code}</code></pre>
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
