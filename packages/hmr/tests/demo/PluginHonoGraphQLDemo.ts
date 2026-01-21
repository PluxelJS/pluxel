// packages/hmr/tests/demo/PluginHonoGraphQLDemo.ts
// 演示型插件：如何在插件里使用 HonoService + GraphQLService。
//
// 目标（给未来的 LLM/开发者看的“最小但完整”范例）：
// - HonoService：通过 ctx.honoService.modifyApp() 注册路由/中间件
// - GraphQLService：通过 ctx.graphql.useModule() 注册 schema（resolver/query/mutation）
// - @Config：给插件加“可被宿主 UI 渲染”的实用配置（valibot-form 元信息）
//
// 试用方式（默认 dev 端口 3000）：
// - 打开 HTML 导览页：GET  /demo
// - 访问 REST 示例：GET  /demo/ping
// - 调 GraphQL：POST /graphql
//
// 注意：
// - modifyApp()/useModule() 都会返回 disposer，并且会自动绑定到插件的 scope 生命周期（通过 ctx.scope.collectEffect）。
// - 配置建议以 `@Config` 注入为准（启动时注入一次）；如需热更新，推荐通过“重载插件”生效。

import { BasePlugin, Config, Plugin } from '@pluxel/hmr'
import { f, v } from '@pluxel/hmr/config'
import type { HonoWithAppEnvType } from '@pluxel/hmr/services'

const SECTION_ROUTES = { id: 'routes', title: 'Routes (Hono)', description: '插件注入的 HTTP 路由' }
const SECTION_GRAPHQL = { id: 'graphql', title: 'GraphQL', description: '插件注入的 GraphQL schema' }

const DEFAULT_ROUTE_PREFIX = '/demo'

const RoutesConfig = v.object({
	prefix: v.pipe(
		v.optional(v.string(), DEFAULT_ROUTE_PREFIX),
		f.formMeta({
			label: '路由前缀',
			description: '建议以 / 开头；示例会注册 /demo/*',
			section: SECTION_ROUTES,
		}),
	),
	enableHtmlIndex: v.pipe(
		v.optional(v.boolean(), true),
		f.formMeta({
			label: '启用 HTML 导览页',
			description: 'GET {prefix} 返回一个可点击的说明页',
			section: SECTION_ROUTES,
		}),
		f.booleanMeta({ variant: 'switch' }),
	),
	enablePing: v.pipe(
		v.optional(v.boolean(), true),
		f.formMeta({
			label: '启用 /ping',
			description: 'GET {prefix}/ping 返回 JSON',
			section: SECTION_ROUTES,
		}),
		f.booleanMeta({ variant: 'switch' }),
	),
})

const GraphQLDemoConfig = v.object({
	greetingPrefix: v.pipe(
		v.optional(v.string(), 'Hello'),
		f.formMeta({
			label: 'greetingPrefix',
			description: 'demoHello 的问候前缀',
			section: SECTION_GRAPHQL,
		}),
	),
	defaultName: v.pipe(
		v.optional(v.string(), 'World'),
		f.formMeta({
			label: 'defaultName',
			description: 'demoHello 未传 name 时的默认值',
			section: SECTION_GRAPHQL,
		}),
	),
})

function normalizePrefix(input: unknown): string {
	const raw = typeof input === 'string' ? input.trim() : ''
	if (!raw) return DEFAULT_ROUTE_PREFIX
	const withSlash = raw.startsWith('/') ? raw : `/${raw}`
	return withSlash.length > 1 && withSlash.endsWith('/') ? withSlash.slice(0, -1) : withSlash
}

@Plugin({ name: 'PluginHonoGraphQLDemo' })
export class PluginHonoGraphQLDemo extends BasePlugin {
	// 这些字段的主要用途是：
	// 1) 让宿主知道有哪些 config schema（用于 UI 表单渲染/默认值补齐/校验）
	// 2) 作为“兜底默认值”的静态来源
	//
	@Config(RoutesConfig)
	private routes!: Config<typeof RoutesConfig>

	@Config(GraphQLDemoConfig)
	private graphql!: Config<typeof GraphQLDemoConfig>

	override async init() {
		// 1) GraphQL：把 resolver 注入到 /graphql 的 schema 中。
		this.registerGraphQLModule()

		// 2) Hono：把 routes 注入到宿主 Hono app 中。
		this.registerHonoRoutes()

		this.ctx.logger.info('PluginHonoGraphQLDemo ready', { prefix: this.readPrefix() })
	}

	private registerGraphQLModule() {
		// GraphQLService 在 HMR 环境里默认使用 @gqloom/core + valibot。
		// 这里从 factory 里取 resolver/query/mutation，避免直接依赖底层实现细节。
		const { resolver, query } = this.ctx.graphql.factory

		// 用 closure 捕获 plugin ctx，这样 resolver 执行时能读到“最新配置”。
		const moduleResolver = resolver({
			// query demoPing: String!
			demoPing: query(v.string()).resolve(() => 'pong'),

			// query demoEcho(message: String!): String!
			demoEcho: query(v.string())
				.input({ message: v.string() })
				.resolve((args: { message: string }) => args.message),

			// query demoHello(name: String): String!
			demoHello: query(v.string())
				.input({ name: v.nullish(v.string()) })
				.resolve((args: { name?: string | null }) => {
					const name = args.name
					const who =
						typeof name === 'string' && name.trim() ? name.trim() : (this.graphql.defaultName ?? 'World')
					return `${this.graphql.greetingPrefix ?? 'Hello'}, ${who}!`
				}),
		})

		// 用稳定 key，方便 HMR/重复启动时可替换/清理。
		this.ctx.graphql.useModule(moduleResolver, Symbol.for('pluxel:demo:PluginHonoGraphQLDemo:gql'))
	}

	private readPrefix(): string {
		return normalizePrefix(this.routes?.prefix)
	}

	private registerHonoRoutes() {
		// 路由前缀属于“注册期决定”的结构性配置：
		// - 修改 prefix 后，通常需要重载插件（或触发 HonoService rebuild）才能让新路由生效。
		// - 其它开关类配置（enablePing/enableHtmlIndex）可以在 handler 内按需读取，实现“热更新”。
		const prefix = this.readPrefix()

		this.ctx.honoService.modifyApp((app: HonoWithAppEnvType) => {
			// 小中间件：把 prefix 规范化后挂到 response header，方便调试。
			app.use('*', async (c, next) => {
				c.header('X-Pluxel-Demo-Prefix', prefix)
				await next()
			})

			app.get(prefix, (c) => {
				const enableHtmlIndex = this.routes.enableHtmlIndex ?? true
				if (!enableHtmlIndex) return c.notFound()

				const pluginName = c.var.plugin_ctx.pluginInfo?.id ?? 'unknown'
				const gqlEndpoint = '/graphql'

				return c.html(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Pluxel Demo - Hono + GraphQL</title>
  </head>
  <body>
    <h1>PluginHonoGraphQLDemo</h1>
    <p>plugin: <code>${pluginName}</code></p>
    <p>routes prefix (config): <code>${prefix}</code></p>
    <h2>REST</h2>
    <ul>
      <li><a href="${prefix}/ping">${prefix}/ping</a></li>
    </ul>
    <h2>GraphQL</h2>
    <p>endpoint: <code>${gqlEndpoint}</code></p>
    <pre>curl -s ${gqlEndpoint} -H 'content-type: application/json' \\
  --data-binary '{\"query\":\"query($name:String){ demoHello(name:$name) demoPing }\",\"variables\":{\"name\":\"Pluxel\"}}'</pre>
    <p>提示：GraphiQL 是否开启由服务器环境控制（非本插件）；默认 dev 环境会开启。</p>
  </body>
</html>`)
			})

			app.get(`${prefix}/ping`, (c) => {
				const enabled = this.routes.enablePing ?? true
				if (!enabled) return c.notFound()

				// HonoService 会把 plugin_ctx 注入到 Hono context 变量里：
				// - 在任意 handler 中都可以拿到 ctx/services/logger 等
				const plugin = c.var.plugin_ctx.pluginInfo?.id ?? 'unknown'

				return c.json({
					ok: true,
					plugin,
					now: Date.now(),
					greetingPrefix: this.graphql.greetingPrefix ?? 'Hello',
					defaultName: this.graphql.defaultName ?? 'World',
				})
			})
		})
	}
}
