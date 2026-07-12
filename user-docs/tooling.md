# CLI 与工具链

`@pluxel/cli` 是按命令加载的编排入口，不是 runtime 或构建 API 的聚合包。

插件写法、最佳实践和 Pluxel 增补 lint rules 分别见
[`plugin-authoring.md`](plugin-authoring.md)、
[`plugin-best-practices.md`](plugin-best-practices.md) 和 [`oxlint.md`](oxlint.md)。本页只说明命令
和 package ownership。

只创建项目时安装 CLI 即可：

```sh
pnpm add -D @pluxel/cli
pluxel new
```

按使用的命令补充能力：

```sh
# 构建插件或管理 workspace
pnpm add -D @pluxel/rolldown tsdown oxlint

# 编辑和诊断 dynamic loader HMR profile
pnpm add -D @pluxel/runtime-dynamic
```

缺少可选包时只禁用对应命令，不影响根帮助和脚手架。

代码中不要从 CLI 导入 build、Rolldown 或 HMR API，应直接使用所有者入口：

```ts
import { resolveBuildContext } from '@pluxel/rolldown/build'
import { diagnoseLoaderHmrWorkspace } from '@pluxel/runtime-dynamic/hmr/diagnose'
```

`hmr/diagnose` 只处理配置、workspace discovery、profile 和 snapshot，不注册 dynamic runtime services。
