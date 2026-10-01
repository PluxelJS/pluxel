# Coding agent 工作入口

开发 Pluxel 应用或插件前读取 `.agents/skills/pluxel-development/SKILL.md` 与 `docs/pluxel/development/index.md`，按任务选择 inspect、静态检查、隔离测试和现有 Vite dev console。

入口缺失时：Git 用户从上游 checkout 的 CLI 执行 `source install --root <本项目>`；npm 用户安装依赖后执行 `pnpm exec pluxel workspace setup`。`pnpm exec pluxel docs` 可直接读取当前来源的正文。CLI 管理生成链接，不复制或提交上游正文。

完成修改后运行 `pnpm verify`，报告实际检查结果与未验证边界；在线效果需要现有 dev console 的实际证据。

## 本包构建与检查

- 修改插件、公共契约、package metadata、`tsdown.config.ts` 或 `oxlint.config.ts` 前，按开发指南确认对应契约；包发布见 `pnpm exec pluxel docs development/plugin-package.md`。
- `tsdown.config.ts` 只描述包的输入输出；`pluxel build` 拥有编译语义与生成的插件依赖 metadata。
- 完成后运行 `pnpm verify`；不得无理由绕过 Pluxel lint 规则。
