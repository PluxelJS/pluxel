---
title: 跨仓库源码开发
description: 在保持 Git 仓库、工作区和 lockfile 独立的前提下联调本地源码。
---

在同时开发 Pluxel 框架源码与外部业务插件（或消费应用）时，`pluxel source` 工具链允许在保持各个仓库独立的 Git 分支、依赖锁文件（`pnpm-lock.yaml`）和构建配置的前提下，实现本地代码的实时符号链接与跨仓联调。

<span id="准备-checkout-和-cli"></span>
## 准备源码环境与 CLI

1. 分别克隆消费应用仓库与 Pluxel 框架源码仓库。
2. 在 Pluxel 仓库根目录下构建 CLI：
   ```sh
   vp run @pluxel/cli#build
   ```
3. 将构建生成的 `packages/cli/bin/pluxel.mjs` 通过符号链接加入系统 PATH 或作为全局指令调用。

## 声明跨仓库源码依赖

在消费应用的根目录下创建 `pluxel.sources.jsonc` 配置文件：

```jsonc
{
	"version": 1,
	"sources": [
		"https://github.com/PluxelJS/pluxel",
		"https://github.com/PluxelJS/chatbot"
	],
	"singletons": ["drizzle-orm"]
}
```

- `sources`：声明需本地联调的上游 Git 仓库远程 URL。
- `singletons`：指定跨子包必须保证物理单例的依赖库（例如 ORM 核心驱动），防止多个包加载不同实例引发类型或原型链冲突。

## 注册与关联本地目录

将本地检出的物理路径注册到当前工作区：

```sh
# 注册本地代码路径
pluxel source register /path/to/local/pluxel
pluxel source register /path/to/local/chatbot

# 查看已注册的源码仓库列表
pluxel source list

# 生成本地模块 Overlay 映射并安装依赖
pluxel source install

# 检查跨仓联调环境配置
pluxel source doctor
```

- `source install` 会在消费工程中生成专用的 `.pnpmfile.cjs` 与 `.pluxel/` 覆盖目录，将外部依赖自动指向本地源码的构建输出。
- 该覆盖文件属于本地调试资产，需加入 `.gitignore`。

<span id="何时重新安装或构建"></span>
## 何时需要重新构建或安装

- **上游仓库增删依赖或改动包名**：运行 `pluxel source install` 更新模块代理拓扑。
- **修改了框架核心代码**：运行 `pluxel source build` 重新编译所需的 ESM 产物，再重启本地 dev 服务。
- **仅构建特定子包**：可通过 `pluxel source build --package @pluxel/core` 执行定向构建。

<span id="文档skill-与接入状态"></span>
## 开发文档与 AI Skill 自动接入

在应用工程中，可通过以下命令将框架内置的开发文档和 coding agent skill 软链接到本地：

```sh
# 针对源码联调工程
pluxel source install

# 针对普通 npm 安装工程
vp exec pluxel workspace setup
```

- 命令会自动将框架离线文档链接至 `docs/pluxel`，并将技能规范接入 `.agents/skills/pluxel-development`。
- 本地查阅文档：`pluxel docs <path>`（例如 `pluxel docs plugin-development/testing.md`）。

<span id="统一外部依赖"></span>
## 工作区依赖版本治理与 Catalog

Pluxel 推荐使用 pnpm Catalog 统一约束第三方依赖版本，避免多包依赖版本漂移：

```sh
# 自动迁移 package.json 中的第三方裸版本至 catalog
pluxel pncat migrate --yes --no-install

# 将工作区 catalog 版本与官方政策对齐
pluxel workspace sync

# 安装依赖并生成锁文件
vp install

# 检查当前依赖是否符合规范
pluxel workspace sync --check
```

- `pncat.config.ts`：定义依赖的分组（如 `runtime`、`test`、`tooling`）与归类规则。
- `workspace sync --check`：在 CI 中执行检查，若存在未受管的裸版本或版本冲突则非零退出。
