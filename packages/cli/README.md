# @pluxel/cli

Pluxel 命令入口。项目内固定版本后使用 `pnpm exec pluxel`；参数见 `pluxel <command> --help`。

```sh
pnpm add -D @pluxel/cli
pnpm exec pluxel docs development/index.md
```

| 任务                | 命令与指南                                                                                    |
| ------------------- | --------------------------------------------------------------------------------------------- |
| 创建 Plugin package | `pluxel new`；[模板与安装](../../docs/development/tooling.md)                                 |
| 构建与发布 Plugin   | `pluxel build` / `publish`；[插件包](../../docs/development/plugin-package.md)                |
| 操作已有 Vite 应用  | `pluxel dev instances/run/result/cancel`；[开发控制台](../../docs/development/dev-console.md) |
| 跨仓库源码联调      | `pluxel source` / `workspace`；[源码工作区](../../docs/development/source-workspaces.md)      |
| 验证发行物          | `pluxel distribution`；[应用交付](../../docs/development/distribution.md)                     |

完整应用由 `pnpm create @pluxel` 创建。源码检查使用 `@pluxel/rolldown/inspect` 的 library API。

命令按需加载能力，从调用项目解析可选包；`--help`、`--version`、`new` 不加载构建工具或 market SDK。全局 launcher 优先委托项目直接声明的本地 CLI；`source` 保留独立执行以建立本地安装。详细安装契约见工具链指南。

CLI 只拥有参数、交互和编排，不维护另一份插件目录、运行状态或 HMR 协议。实现入口见 [IMPLEMENTATION_INDEX.md](./IMPLEMENTATION_INDEX.md)。模板发布验证使用 `pnpm --filter @pluxel/cli test:templates`，覆盖仓库外 tarball 安装、生成、检查和构建。
