# Coding agent 工作入口

开发 Pluxel 应用或插件前读取 `.agents/skills/pluxel-development/SKILL.md` 与 `docs/pluxel/development/index.md`，按任务选择 inspect、静态检查、隔离测试和现有 Vite dev console。

入口缺失时：Git 用户从上游 checkout 的 CLI 执行 `source install --root <本项目>`；npm 用户安装依赖后执行 `pnpm exec pluxel workspace setup`。`pnpm exec pluxel docs` 可直接读取当前来源的正文。CLI 管理生成链接，不复制或提交上游正文。

完成修改后运行 `pnpm verify`，报告实际检查结果与未验证边界；在线效果需要现有 dev console 的实际证据。

## 本项目位置与检查

- `host/src/app.ts` 是开发与生产共用的应用声明；可选 `sources` 扩展固定 catalog。默认 modules 构建与原生 `start.mjs` 只在启动接纳预编译来源；开发 Vite 持续更新。生产 Vite 使用独立 `vite.runtime.config.ts` 与 `start-vite.mjs`，加载同一 compiled factory。
- 浏览器 React/Vite 代码位于 `host/web/`；Node catalog、配置和路由策略位于 `host/`；共享中立逻辑位于 `packages/`。
- inspect 选择本应用时使用 workspace-relative `application: { root: 'host', entry: 'src/app.ts' }`。
- 修改 `plugins/`、公共契约、Host 配置或 `oxlint.config.ts` 前，按开发指南确认对应契约。应用装配见 `pnpm exec pluxel docs host/configuration.md`。
- 完成后运行 `pnpm verify`；不得无理由绕过 Pluxel lint 规则。

插件范式按需读 `docs/pluxel/plugin-development/`；Host 装配读 `docs/pluxel/host/configuration.md` 的对应章节。已知目标直接定位，不把目录当作通读清单。
