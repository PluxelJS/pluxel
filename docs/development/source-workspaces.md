---
title: 跨仓库源码开发
description: 在保持 Git 仓库、工作区和 lockfile 独立的前提下联调本地源码。
---

当应用需要联调尚未发布的 Pluxel 或另一个独立仓库时，可以用 `pluxel source` 管理开发期的包解析。每个源码仓库仍保留自己的 Git 历史、工作区和 lockfile；这个命令也不会接管运行时的 Plugin 安装。

## 声明源码仓库

在消费方根目录提交 `pluxel.sources.jsonc`：

```jsonc
{
	"version": 1,
	"sources": ["https://github.com/PluxelJS/pluxel", "https://github.com/PluxelJS/chatbot"],
	"singletons": ["drizzle-orm"],
}
```

`sources` 只接受 Git repository URL，不接受机器路径、package 列表或构建命令。CLI 会规范化 HTTPS、SSH 和 `.git` 形式，拒绝未知字段、重复 repository 和不支持的版本。

## 安装和运行

每台机器先用独立安装的 CLI 登记实际 checkout；机器路径只写入用户 registry：

```sh
pluxel source register /path/to/pluxel
pluxel source register /path/to/chatbot
pluxel source install
pluxel source doctor
pnpm dev
```

即使消费项目声明了 `@pluxel/cli` 但还没有 `node_modules`，`pluxel source` 也会继续使用当前全局安装或
`pnpm dlx` CLI；`source install` 安装完成后，其他命令自动恢复使用项目固定版本。这个例外只覆盖 source
自举，不允许 build、HMR 或发布绕过项目 lockfile。

移动 checkout 或修改 `pluxel.sources.jsonc` 后需要重新登记并运行 `source install`；已接入 checkout 内的普通源码修改不需要重装。
`.pnpmfile.cjs` 与 `.pluxel/` 都是 CLI 生成的机器本地 overlay，应被 Git 忽略，不是需要提交的 workspace 配置。
因此新 checkout 可以先运行 Corepack、`pnpm store path` 等不安装依赖的命令，再由独立 CLI 激活 source overlay。

CLI 扫描每个 checkout 自己的 workspace 和 manifest，按实际依赖闭包创建代理。source package 的 devDependencies 仍属于它自己的 checkout，不进入消费方 closure。
安装和构建顺序从实际 package dependency graph 推导；provider repository 先完成，互不依赖的 repository 可并行。
`--frozen-lockfile` 只在显式传入时生效。

`pluxel source build` 默认构建本次 closure 中所有确实发布 artifact 的 package。只需要让 Vitest preset 在 config 求值前可用时，使用可重复的
`--package` 精确选择：

```sh
pluxel source build --package @pluxel/test
```

默认尊重 source checkout 自己的 Turbo 缓存；只有明确需要重新执行时才使用 `pluxel source build --force`。
具有非标准 artifact 目录的 package 可以在 manifest 中声明 `"pluxel": { "sourceBuild": true }`；纯源码 package
也可显式声明 `false`。省略时 CLI 继续根据标准 package entry 推断。

CLI 会拒绝不在当前 closure 中或本来不需要 artifact 的名称；被选 package 自己的 Turbo/pnpm task graph 仍决定必要前置。这个窄构建不安装依赖、
不改 consumer lockfile，也不替代 production build 或 source install。

`singletons` 只用于具有 nominal/private identity 的 direct dependency，而且必须能从本次选中的 source package 中推导出唯一 owner。不要把 node_modules 绝对路径写进配置。

## 与 dynamic sources 的区别

| 能力                   | 所有者        | 时机                                          |
| ---------------------- | ------------- | --------------------------------------------- |
| `pluxel source`        | CLI           | 开发期 package resolution、构建和 live source |
| runtime `sources`      | dynamic route | 运行期观察已发布的 ESM plugin entry           |
| package manager Plugin | host 显式装配 | 运行中的安装/删除操作                         |

三者不是同一个 lifecycle。source install 不会替 dynamic route 发布 mutable entry，dynamic route 也不会下载 source checkout。

## 边界和排错

- 每个 checkout 保留自己的 Git、pnpm workspace 和 lockfile。
- 不在根 workspace 增加机器路径或 nested workspace pattern。
- 上游有 Turbo 时，把目标交给它自己的 task graph；不要复制 package filter。
- source checkout 的 Plugin 仍必须经过 Pluxel Vite/Rolldown pipeline。
- 解析冲突先看 package identity、singletons 和 dependency owner，再看 lockfile。
- `pluxel source doctor` 同时检查 checkout identity、当前 package closure、生成的 pnpmfile 和每个稳定代理；配置正确但 overlay 未安装或已漂移也会失败。
