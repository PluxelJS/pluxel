# Create 实现入口

修改初始化器或固定 starter 时使用本页；创建命令与包边界见 [README](README.md)。

| 位置                       | 负责                                                                              |
| -------------------------- | --------------------------------------------------------------------------------- |
| `src/create.ts`            | 类型化参数解析、安全暂存复制、可选 pnpm 安装与诊断                                |
| `tsdown.config.ts`         | npm bin、Node 24 ESM 单文件构建、模板复制，以及按可发布包版本更新发布模板 catalog |
| `template/`                | 无插值的固定示例 monorepo 源码                                                    |
| `tests/create.test.mjs`    | 目标目录行为、工作区治理、文档链接                                                |
| `scripts/smoke-starter.ts` | 仓库外打包安装、工作区验证、生产发行物与统一 Vite 集成                            |

初始化器与 `@pluxel/cli` 没有实现依赖或共享 scaffold library；生成项目对 CLI 的依赖不改变此边界。改变 starter 时同时验证生成后的工作区，不以模板源码检查代替。
