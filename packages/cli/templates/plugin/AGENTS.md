# Coding agent 工作入口

开发 Pluxel 应用或插件前先使用 [pluxel-development skill](.agents/skills/pluxel-development/SKILL.md)，由 skill 指导工具选择、开发服务、日志和在线操作；只按当前任务展开其引用文档。

入口缺失时：Git 用户从上游 checkout 的 CLI 执行 `source install --root <本项目>`；npm 用户安装依赖后执行 `vp exec pluxel workspace setup`。`vp exec pluxel docs` 可直接读取当前来源的正文。CLI 管理生成链接，不复制或提交上游正文。

完成修改后运行 `vp run verify`，报告实际检查结果与未验证边界；在线效果需要现有 dev console 的实际证据。

## 本包构建与检查

- 修改插件、公共契约、package metadata、`tsdown.config.ts` 或 `oxlint.config.ts` 前，按开发指南确认对应契约；包发布见 `vp exec pluxel docs development/plugin-package.md`。
- `tsdown.config.ts` 只描述包的输入输出；`pluxel build` 拥有编译语义与生成的插件依赖 metadata。
- 完成后运行 `vp run verify`；不得无理由绕过 Pluxel lint 规则。

工作区默认使用 mise 固定 Node、pnpm、Vite+ 和 hk；先 `mise trust`、`mise install`、`vp install`、`vp run setup`，已有 Git 仓库再 `vp run hooks:install`。`hk.pkl` 只选择文件并调用 `vp check`；完整验证使用 `vp run verify` 原生任务图。根 `vite.config.ts` 统一格式规则与启用类型检查的 lint 配置。
