import { Link } from 'fumapress/client'
import { ArrowRight, Boxes, Braces, CircleDot, CloudCog, ServerCog, Settings2 } from 'lucide-react'
import { PluginShowcase } from '../components/plugin-showcase'

const patterns = [
	{
		code: 'constructor(private readonly http: WretchPlugin) { super() }',
		description: '需要另一个 Plugin 时，直接写构造函数参数。类型就是依赖声明。',
		href: '/docs/plugin-development/model',
		icon: Braces,
		title: '注入依赖',
	},
	{
		code: 'private readonly config = this.configs.use(StatusConfig)',
		description: '读取经过默认值和校验的冻结配置，不再维护平行的 TypeScript interface。',
		href: '/docs/plugin-development/configuration',
		icon: Settings2,
		title: '读取配置',
	},
	{
		code: 'this.ctx.effects.defer(() => clearInterval(timer))',
		description: '创建资源后立即登记释放函数；停止、替换和启动回滚都会执行。',
		href: '/docs/plugin-development/lifecycle',
		icon: Boxes,
		title: '登记清理',
	},
]

const hosts = [
	{
		code: `import { defineHostApplication } from '@pluxel/host'
import { OrdersPlugin } from '@app/orders'

export default defineHostApplication(() => ({
  plugins: [OrdersPlugin],
}))`,
		description:
			'插件清单在应用构建时静态打包，开发时支持实时热更新。通过 policy.autoStart 指定应用启动时默认运行的插件。',
		icon: ServerCog,
		meta: 'Fixed catalog',
		title: '固定插件目录',
	},
	{
		code: `import { defineHostApplication } from '@pluxel/host'
import { pluginSource } from '@pluxel/host/sources'

export default defineHostApplication(() => ({
  plugins: [],
  sources: [pluginSource({
    kind: 'directory', path: './plugins',
    include: ['*.mjs'],
  })],
}))`,
		description:
			'开发期间可在指定目录新增、更新或移除插件文件，宿主会自动发现变动并按运行策略加载。',
		icon: CloudCog,
		meta: 'Mutable sources',
		title: '增加动态来源',
	},
]

const toolchain = [
	{
		title: '安装服务',
		file: 'src/app.ts',
		code: `import { defineHostApplication } from '@pluxel/host'
import { servicesPreset } from '@pluxel/services/preset'

export default defineHostApplication(async (startup) => ({
  plugins: [],
  services: await servicesPreset(startup, {}),
}))`,
	},
	{
		title: '开发与热更新',
		file: 'vite.config.ts',
		code: `import { defineConfig } from 'vite'
import { vitePreset } from '@pluxel/services/vite'

export default defineConfig({
  plugins: [vitePreset({
    entry: './src/app.ts', scripts: true,
  })],
})`,
	},
	{
		title: '生产构建',
		file: 'tsdown.config.ts',
		code: `import { defineConfig } from 'vite-plus/pack'
import { pluxel } from '@pluxel/rolldown'

export default defineConfig({
  entry: './src/app.ts',
  plugins: [pluxel()],
})`,
	},
]

export default function HomePage() {
	return (
		<>
			<title>Pluxel — TypeScript Plugin Runtime</title>
			<meta
				name="description"
				content="以类型化依赖、确定性生命周期和统一配置构建 TypeScript Plugin。"
			/>
			<meta property="og:title" content="Pluxel — TypeScript Plugin Runtime" />
			<meta
				property="og:description"
				content="以类型化依赖、确定性生命周期和统一配置构建 TypeScript Plugin。"
			/>
			<div className="pluxel-home">
				<section className="pluxel-hero">
					<div className="pluxel-hero-copy">
						<p className="pluxel-kicker">
							<CircleDot aria-hidden="true" /> TypeScript Plugin Runtime
						</p>
						<h1>Pluxel</h1>
						<p className="pluxel-hero-lead">
							写一个普通的 TypeScript 类，直接在构造函数中注入所需插件。
							配置校验、路由挂载与资源回收清晰直观，开发阶段支持快速热重载。
						</p>
						<div className="pluxel-hero-actions">
							<Link className="pluxel-primary-action" href="/docs/getting-started">
								创建项目 <ArrowRight aria-hidden="true" />
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
						<p className="pluxel-kicker">
							<Braces aria-hidden="true" /> 直接看日常写法
						</p>
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
									<span className="pluxel-card-link">
										阅读文档 <ArrowRight aria-hidden="true" />
									</span>
								</Link>
							)
						})}
					</div>
				</section>

				<section className="pluxel-docs-section" aria-labelledby="choose-host">
					<div className="pluxel-section-heading">
						<p className="pluxel-kicker">
							<ServerCog aria-hidden="true" /> 最后放进宿主
						</p>
						<h2 id="choose-host">Plugin 写法不随宿主改变</h2>
					</div>
					<div className="pluxel-host-cards">
						{hosts.map((host) => {
							const Icon = host.icon
							return (
								<Link key={host.title} href="/docs/host/configuration" className="pluxel-doc-card">
									<Icon aria-hidden="true" />
									<span className="pluxel-card-meta">{host.meta}</span>
									<h3>{host.title}</h3>
									<pre className="pluxel-host-code">
										<code>{host.code}</code>
									</pre>
									<p>{host.description}</p>
									<span className="pluxel-card-link">
										配置宿主 <ArrowRight aria-hidden="true" />
									</span>
								</Link>
							)
						})}
					</div>
				</section>

				<section className="pluxel-docs-section" aria-labelledby="host-toolchain">
					<div className="pluxel-section-heading">
						<h2 id="host-toolchain">同一份应用，开发与生产共用</h2>
						<p>
							在应用配置中按需挂载核心服务；本地尝鲜支持纯内存模式，生产部署可自由配置持久化存储。
						</p>
					</div>
					<div className="pluxel-host-cards">
						{toolchain.map((item) => (
							<Link key={item.file} href="/docs/host/configuration" className="pluxel-doc-card">
								<span className="pluxel-card-meta">{item.file}</span>
								<h3>{item.title}</h3>
								<pre className="pluxel-host-code">
									<code>{item.code}</code>
								</pre>
							</Link>
						))}
					</div>
				</section>
			</div>
		</>
	)
}
