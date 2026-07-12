# 从纯净 monorepo 开始

新产品优先从 canonical starter 开始，不要复制仓库内的复杂业务项目：

```bash
pluxel new --template app-monorepo --name @acme/my-app
cd my-app
pnpm install
pnpm verify
pnpm dev
```

生成结构只包含三个所有权边界：

```text
web             独立 workspace；Vite、static host、React HMR 与 GQLens
plugins/example 插件生命周期、配置和业务 HTTP
packages/domain web 与 plugin 共用、不依赖 Pluxel 的中性领域逻辑
docs             当前模板的插件作者与 Oxlint 就地指南
AGENTS.md        指示 coding agent 先读取就地指南和验证要求
```

根目录只负责编排 workspace 和共享质量工具。唯一部署单元 `web` 直接拥有前端与 static runtime
依赖；`packages/*` 只用于真正跨边界复用的中性库。出现第二个独立部署目标时，再将 `web`
迁入 `apps/*` 层级。

## 为什么默认关闭 Web Management

模板用 `webManagement: false` 验证业务能力不依赖可选管理面。开启管理面时，只修改
`web/src/pluxel.static.ts` 的宿主配置；业务 HTTP、领域状态和持久化不能迁入
`webManagement.use()` callback。

## 依赖规则

- Pluxel 发布包使用正常 semver，不使用 `workspace:*`。
- 只有当前应用自己拥有的 package 使用 `workspace:*`。
- React、React DOM、GQLens client 和 Vite 是 `web` 的直接依赖，不进入根、插件或中性 package。
- Vite、Vitest 和插件源码只使用公开 package subpath，不引用 Pluxel 仓库相对路径。
- 同一个 Vite pipeline 依次组合 static runtime、GQLens schema codegen 和 React HMR；GraphQL
  业务 endpoint 仍由插件拥有。
- Vault、Web Management 和部署路线由根 host 安装；插件只消费稳定 capability。

根目录生成 `oxlint.config.ts` 和 `.oxfmtrc.json`。Oxlint 配置加载
`@pluxel/rolldown/oxlint` 的 Pluxel 增补规则；`pnpm verify` 同时检查格式、未使用的 lint
抑制、类型、测试和生产构建。

## 模板内文档

生成仓库的 README 先说明插件开发，再说明 host composition。更完整但仍针对当前模板的
`docs/PLUXEL_PLUGIN_GUIDE.md` 包含：

- 标准 plugin shape 与目录所有权；
- required/optional、plugin/feature、业务/管理面的选择表；
- config、lifecycle、cleanup 和 disabled Web Management 的实践；
- 模板启用的每一条 Pluxel Oxlint rule 及修复方向；
- `lint:fix` 到 `verify` 的完成标准。

根 `AGENTS.md` 要求 coding agent 在修改 `plugins/`、contract、host config 或 lint config 前先读
这份指南。它的目标是让生成项目离开 Pluxel 源码仓库后仍有足够的设计上下文；完整、跨模板的
权威说明仍在 [`plugin-authoring.md`](plugin-authoring.md)、
[`plugin-best-practices.md`](plugin-best-practices.md) 和 [`oxlint.md`](oxlint.md)。

## 何时参考 projects

基础结构稳定后，再按需求阅读：

- `projects/chatbots`：复杂 capability、optional integration、长连接和多插件领域模型。
- `projects/external-api-gateway`：外部 API、provider、计费、Vault 和公开 gateway 协议。

这些是高级参考应用，不是生成模板的权威源；标准作者模型仍以
[`plugin-authoring.md`](plugin-authoring.md) 为准。
