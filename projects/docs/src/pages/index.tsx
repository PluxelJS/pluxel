import { Link } from 'fumapress/client'
import { ArrowRight, Boxes, Braces, CircleDot, CloudCog, ServerCog, Settings2 } from 'lucide-react'
import { PluginShowcase } from '../components/plugin-showcase'

const patterns = [
	{
		code: 'constructor(private readonly http: WretchPlugin) { super() }',
		description: '需要另一个 Plugin 时，直接写构造函数参数。类型就是依赖声明。',
		href: '/docs/getting-started/plugin-model',
		icon: Braces,
		title: '注入依赖',
	},
	{
		code: 'private readonly config = this.configs.use(StatusConfig)',
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
		code: `import type { HostApplication } from '@pluxel/host'
import { OrdersPlugin } from '@app/orders'

export default {
  plugins: [OrdersPlugin],
} satisfies HostApplication`,
		description:
			'Plugin 清单随应用构建，开发期支持 HMR。目录表示代码可用，冷启动策略通过 state.initial.autoStart 显式选择。',
		icon: ServerCog,
		meta: 'Fixed catalog',
		title: '固定插件目录',
	},
	{
		code: `import type { HostApplication } from '@pluxel/host'
import { dynamicSource } from '@pluxel/host-dynamic'

export default {
  sources: [dynamicSource({
    kind: 'directory', path: './plugins',
    include: ['*.mjs'],
  })],
} satisfies HostApplication`,
		description:
			'开发期新增、更新、删除文件入口，变化提交到同一 Host catalog；是否启动仍由运行策略决定。',
		icon: CloudCog,
		meta: 'Mutable sources',
		title: '增加动态来源',
	},
]

const toolchain = [
	{
		title: '安装服务',
		file: 'src/app.ts',
		code: `import type { HostApplication } from '@pluxel/host'
import { servicesPreset } from '@pluxel/services'

export default {
  async configure(startup) {
    return {
      services: await servicesPreset(startup, {
        persistence: { mode: 'memory' },
      }),
    }
  },
} satisfies HostApplication`,
	},
	{
		title: '开发与热更新',
		file: 'vite.config.ts',
		code: `import { defineConfig } from 'vite'
import { vitePreset } from '@pluxel/services/vite'

export default defineConfig({
  plugins: [vitePreset({
    entry: './src/app.ts', devConsole: true,
  })],
})`,
	},
	{
		title: '生产构建',
		file: 'tsdown.config.ts',
		code: `import { defineConfig } from 'tsdown'
import { buildPreset } from '@pluxel/services/build'

export default defineConfig({
  entry: './src/app.ts',
  plugins: [buildPreset()],
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
							写一个 class，用构造函数注入能力；配置、HTTP route
							和资源清理都放在固定位置，开发期直接热更新。
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
								<Link
									key={host.title}
									href="/docs/getting-started/host-setup"
									className="pluxel-doc-card"
								>
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
							在上面的应用声明中加入
							configure，显式选择服务；内存存储适合本地尝试，持久部署见宿主配置。
						</p>
					</div>
					<div className="pluxel-host-cards">
						{toolchain.map((item) => (
							<Link
								key={item.file}
								href="/docs/getting-started/host-setup"
								className="pluxel-doc-card"
							>
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
