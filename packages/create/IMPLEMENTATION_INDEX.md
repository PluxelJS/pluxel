# Create 实现入口

修改初始化器或固定 starter 时使用本页；创建命令与包边界见 [README](README.md)。

| 位置                       | 负责                                                                                               |
| -------------------------- | -------------------------------------------------------------------------------------------------- |
| `src/create.ts`            | 类型化参数解析、安全暂存复制、可选 pnpm 安装与诊断                                                 |
| `tsdown.config.ts`         | npm bin、Node 24 ESM 单文件构建、模板复制，以及通过 pncat 按核心政策和可发布包版本更新模板 catalog |
| `template/`                | 无插值的固定示例 monorepo 源码                                                                     |
| `tests/create.test.mjs`    | 目标目录行为、工作区治理、文档链接                                                                 |
| `scripts/smoke-starter.ts` | 仓库外打包安装、工作区验证、生产发行物与统一 Vite 集成                                             |

初始化器运行时不依赖 `@pluxel/cli`，也没有共享 scaffold library。构建模板复用 CLI 的核心 catalog 政策读取器与 pncat plan/apply；版本政策只维护在根 workspace，内部包版本仍由 Tegami 提供。改变 starter 时同时验证生成后的工作区，不以模板源码检查代替。
