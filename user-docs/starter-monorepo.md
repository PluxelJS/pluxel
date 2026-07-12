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
apps/host       宿主策略、static catalog、持久化与 Web Management 开关
plugins/example 插件生命周期、配置和业务 HTTP
packages/domain 不依赖 Pluxel 的领域逻辑
```

## 为什么默认关闭 Web Management

模板用 `webManagement: false` 验证业务能力不依赖可选管理面。开启管理面时，只修改
`apps/host/src/pluxel.static.ts` 的宿主配置；业务 HTTP、领域状态和持久化不能迁入
`webManagement.use()` callback。

## 依赖规则

- Pluxel 发布包使用正常 semver，不使用 `workspace:*`。
- 只有当前应用自己拥有的 package 使用 `workspace:*`。
- Vite、Vitest 和插件源码只使用公开 package subpath，不引用 Pluxel 仓库相对路径。
- Vault、Web Management 和部署路线由 `apps/host` 安装；插件只消费稳定 capability。

## 何时参考 projects

基础结构稳定后，再按需求阅读：

- `projects/chatbots`：复杂 capability、optional integration、长连接和多插件领域模型。
- `projects/external-api-gateway`：外部 API、provider、计费、Vault 和公开 gateway 协议。

这些是高级参考应用，不是生成模板的权威源；标准作者模型仍以
[`plugin-authoring.md`](plugin-authoring.md) 为准。
