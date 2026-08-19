import { Link } from 'fumapress/client'
import { createHomeLayout } from 'fumapress/layouts/home'
import {
	ArrowRight,
	Boxes,
	Braces,
	Check,
	CircleDot,
	GitBranch,
	PackageCheck,
	RefreshCw,
	ShieldCheck,
} from 'lucide-react'

const HomeLayout = createHomeLayout()

const stages = [
	{
		description: '构造函数中的依赖直接成为类型约束，不再另写一份运行时声明。',
		icon: Braces,
		title: '从 TypeScript 读取依赖',
	},
	{
		description: '构建阶段生成静态描述，缺失依赖和循环在启动前就能暴露。',
		icon: GitBranch,
		title: '构建可检查的 Plugin 图',
	},
	{
		description: 'Runtime 按代际发布服务；重载、失败和资源清理遵循同一套生命周期。',
		icon: RefreshCw,
		title: '让变更完整地生效',
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

					<div className="pluxel-runtime-window" aria-label="Pluxel 构建与运行状态示例">
						<div className="pluxel-window-bar">
							<span>packages/greeter/src/index.ts</span>
							<span className="pluxel-build-state"><Check aria-hidden="true" /> graph valid</span>
						</div>
						<div className="pluxel-runtime-grid">
							<pre className="pluxel-code"><code><span>export class</span>{' Greeter {\n'}
{'  '}<span>constructor</span>{'('}<em>http</em>{': Http, '}<em>logger</em>{': Logger) {}\n\n'}
{'  '}<span>start</span>{'() {\n'}
{"    this.logger.info('ready')\n"}
{'  }\n}'}</code></pre>
							<div className="pluxel-runtime-panel">
								<p className="pluxel-panel-label">Generated dependency graph</p>
								<div className="pluxel-graph-row">
									<strong>Greeter</strong>
									<span>requires</span>
									<strong>Http</strong>
									<strong>Logger</strong>
								</div>
								<div className="pluxel-generation">
									<div><span>generation</span><strong>#12</strong></div>
									<div><span>status</span><strong className="pluxel-status"><span /> running</strong></div>
									<div><span>resources</span><strong>3 owned</strong></div>
								</div>
							</div>
						</div>
					</div>
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
								<article key={stage.title} className="pluxel-stage">
									<div className="pluxel-stage-index">0{index + 1}</div>
									<Icon aria-hidden="true" />
									<h3>{stage.title}</h3>
									<p>{stage.description}</p>
								</article>
							)
						})}
					</div>
				</section>

				<section className="pluxel-hosts" aria-labelledby="choose-host">
					<div className="pluxel-section-heading">
						<p className="pluxel-kicker"><ShieldCheck aria-hidden="true" /> 明确的宿主边界</p>
						<h2 id="choose-host">按部署方式选择 Runtime</h2>
						<p>Plugin API 保持一致，宿主只决定依赖图何时生成、何时可以变化。</p>
					</div>
					<div className="pluxel-host-compare">
						<Link href="/docs/getting-started/host-setup" className="pluxel-host-option">
							<span>Static host</span>
							<strong>固定部署图，构建时完成验证</strong>
							<ArrowRight aria-hidden="true" />
						</Link>
						<Link href="/docs/getting-started/host-setup" className="pluxel-host-option">
							<span>Dynamic host</span>
							<strong>运行时装卸 Plugin，支持配置驱动更新</strong>
							<ArrowRight aria-hidden="true" />
						</Link>
					</div>
				</section>

				<section className="pluxel-plugins" aria-labelledby="official-plugins">
					<PackageCheck aria-hidden="true" />
					<div>
						<h2 id="official-plugins">需要 HTTP、缓存或可观测性？</h2>
						<p>核心只定义 Plugin 与 Runtime。服务端能力由官方 Plugin 按需安装。</p>
					</div>
					<Link href="/docs/plugins">查看官方 Plugin <ArrowRight aria-hidden="true" /></Link>
				</section>
			</main>
		</HomeLayout>
	)
}
