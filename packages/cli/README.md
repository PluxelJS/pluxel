# @pluxel/cli

Pluxel CLI（对外发布包之一）。

它是用户侧的入口（build / scaffold / hmr 等命令），自身不定义 runtime 或前端协议，只负责把已有能力组织成命令行体验。

如果你在追：

- runtime / hmr / build 的总边界：看 `docs/architecture/system.md`
- 插件前端链路：看 `docs/architecture/frontend.md`
- 发布与内联约束：看 `docs/governance/packaging.md`

文档入口：

- `docs/architecture/system.md`
- `docs/architecture/frontend.md`
- `docs/governance/packaging.md`
- `docs/governance/agent-rules.md`

常用：

```sh
pluxel build
pluxel hmr
pluxel new
```

## 在前端链路里的角色

对插件前端来说，CLI 主要负责两件事：

- `pluxel hmr`
  启动 `@pluxel/hmr` host，让 `ui(...).bind(ctx)` 这类 authoring bridge 在开发期生效
- `pluxel build`
  走 `@pluxel/build` 的默认 overlay，把 authoring/HMR 语义降成 runtime 可消费的产物

也就是说，CLI 是命令入口，不是前端架构本身的一层。

## 怎么理解这个包

可以把 CLI 当成一个很薄的 orchestration layer：

- `pluxel hmr`
  组装 `@pluxel/hmr`
- `pluxel build`
  组装 `@pluxel/build` + 相关 build helper
- `pluxel new`
  组装脚手架能力

因此 CLI 文档只回答“命令把哪些能力串起来”，不会重新定义 runtime/HMR/build 的架构边界。
