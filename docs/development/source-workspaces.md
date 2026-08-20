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

```sh
pluxel source install
pluxel source doctor
pnpm dev
```

CLI 扫描每个 checkout 自己的 workspace 和 manifest，按实际依赖闭包创建代理。source package 的 devDependencies 仍属于它自己的 checkout，不进入消费方 closure。

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
