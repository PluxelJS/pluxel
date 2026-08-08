# Pluxel 插件开发指南

这里服务插件作者和修改插件的 coding agent。文档按实际工作流组织：先建立可发布的 package，再写插件、
测试和 review；宿主安装是独立的后续路径。

## 插件作者最短路径

1. [`plugin-package.md`](plugin-package.md)：创建插件 package，配置 `package.json`、`tsconfig.json`、
   `tsdown.config.ts`，理解生成 metadata，并完成构建和发布检查。
2. [`plugin-authoring.md`](plugin-authoring.md)：从标准插件形状开始，掌握依赖、配置、生命周期、
   HTTP、Workbench Plane 和公开 capability。
3. [`database.md`](database.md)：选择 plugin/application database ownership、migration/reset evolution、transaction 与 live query。
4. [`cache.md`](cache.md)：用显式 scope 组合同步 L1、异步 backend、数据库 loader、主动失效与请求合并。
5. [`rates.md`](rates.md)：使用 caller-aware 四算法 admission control、处理 deny/error 并选择 memory/Redis backend。
6. [`redis.md`](redis.md)：使用独立 Redis capability、选择 provider 并桥接 cache/rates backend。
7. [`storage.md`](storage.md)：使用统一 s3mini API 并在 local、S3 与平台 provider 之间切换。
8. [`wretch.md`](wretch.md)：使用原生 immutable Wretch client、统一宿主策略与可选 HTTP 设置 Port。
9. [`otel.md`](otel.md)：直接使用标准 OpenTelemetry Meter/Tracer/Logger，并选择 OTLP signal 与 Prometheus pull。
10. [`fonts.md`](fonts.md)：统一管理系统字体、Pluxel 上传字体、程序化注册、默认选择与 Fonts Selection Port。
11. [`canvas.md`](canvas.md)：使用有资源预算的原生服务端 Canvas，并与 Fonts 插件组合。
12. [`testing.md`](testing.md)：使用 `@pluxel/test/vitest`、core/runtime test host 和 Vitest 验证真实
    插件生命周期、HTTP、失败传播、cleanup 与 disabled Workbench Plane。
13. [`commands.md`](commands.md)：把同一能力暴露为 Agent tool、CLI 或消息指令，并保持权限与 carrier 所有权。
14. [`plugin-best-practices.md`](plugin-best-practices.md)：写代码和 review 时使用的所有权决策、
    常见反模式与提交检查表。
15. [`oxlint.md`](oxlint.md)：Pluxel 增补规则保护的设计约束、修复方式和推荐配置。

CLI 的 `plugin` 和 `app-monorepo` 模板都会把这组文档原样复制到生成仓库的
`docs/pluxel/`，根 `AGENTS.md` 会要求 coding agent 从 `docs/pluxel/README.md` 开始。生成项目
不维护另一套改写版 API 指南。

## 先做这四个判断

| 问题                                         | 选择                                                                        |
| -------------------------------------------- | --------------------------------------------------------------------------- |
| 缺少另一个插件时，本插件是否无法工作？       | 是：constructor；否：`plugins.use(Token)`；包也可缺：`optionalPlugin()` ref |
| 这段组成是否拥有独立插件生命周期和替换边界？ | 是：plugin；否：feature                                                     |
| 这是业务 API 还是只服务管理 UI？             | 业务：`ctx.http.plugin`；管理：`ctx.workbench.mount()`                      |
| 资源何时释放？                               | 创建成功后立即用 `ctx.effects.defer()` 登记幂等 cleanup                     |

如果代码无法清楚回答其中一个问题，先解决所有权再继续扩展 API。Pluxel Oxlint 会自动检查
其中可静态判断的部分，但不能替代 required/optional 和业务/Workbench的设计判断。

## 其他任务

- [`workbench.md`](workbench.md)：管理工作台的导航、标签、插件分栏和高效空间使用。
- [`starter-monorepo.md`](starter-monorepo.md)：生成可独立运行、带本地插件指南和完整验证命令的
  canonical application monorepo。
- [`source-workspaces.md`](source-workspaces.md)：让多个独立 pnpm 仓库按语义仓库身份消费本地源码，
  不提交机器路径或手写 override。
- [`host-setup.md`](host-setup.md)：选择 static/dynamic Vite route，配置 Workbench Plane 和启动策略。
- [`package-manager.md`](package-manager.md)：为 dynamic host 装配官方 pnpm package source producer。
- [`distribution.md`](distribution.md)：finalize、检查、签名和可选关联 static application 发行物。
- [`tooling.md`](tooling.md)：CLI 命令、构建环境变量、工具所有权和 HMR diagnostics 速查。

内部架构、实现入口和维护约束只存在于 Pluxel 源码仓库的 maintainer docs。插件作者不需要它们，
插件代码也不要导入 internal helper。

## 文档承诺

- 示例只使用当前公开 API。
- 先给标准写法和选择规则，再解释必要的设计原因。
- 不展示兼容 API、内部 helper 或迁移历史。
- 插件作者行为变化只更新这里；CLI 打包和 `pluxel new` 复制同一份文件，不维护平行指南。
