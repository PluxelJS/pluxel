# Pluxel Maintainer Docs

`docs/` 记录当前实现的架构边界、维护不变量和内部入口。插件作者请从 [`user-docs/README.md`](../user-docs/README.md) 开始，不需要理解这里的内部 wiring。

## 阅读路径

1. [`DESIGN_PRINCIPLES.md`](DESIGN_PRINCIPLES.md)：维护者和 coding agent 必须遵守的工程不变量。
2. [`PLUGIN_SYSTEM.md`](PLUGIN_SYSTEM.md)：插件、runtime、route、toolchain 和 Management Plane 的总边界。
3. 按改动领域阅读：
   - [`CORE.md`](CORE.md)：DI graph、生命周期、feature、effects。
   - [`RUNTIME.md`](RUNTIME.md)：常驻服务、static/dynamic route、可选宿主能力。
   - [`CONFIG.md`](CONFIG.md)：声明、校验、持久化和管理面投影。
   - [`FRONTEND.md`](FRONTEND.md)：插件 UI、interaction 和 workbench ownership。
   - [`TOOLCHAIN.md`](TOOLCHAIN.md)：Vite/Rolldown metadata、artifact 和 lint。
   - [`HMR.md`](HMR.md)：module runner、replacement 和 watcher 边界。
   - [`WORKBENCH.md`](WORKBENCH.md)：host-owned 管理工作台。
4. [`GOVERNANCE.md`](GOVERNANCE.md)：依赖方向、导出和文档维护规则。
5. [`RELEASING.md`](RELEASING.md)：维护者工具版本、Changesets 与可信发布流程。

## 文档职责

- `docs/`：为什么这样分层、内部不变量、代码从哪里看起。
- `user-docs/`：用户应该写什么、如何选择 API、如何避免错误设计。
- package README：安装、入口和本包特有操作。
- `docs/proposals/`：尚未实现的研究，不得作为当前 API 依据。

## 写作规则

- 只描述当前模型，不维护“旧 API 已删除”清单；历史由 Git 保存。
- 一个事实只有一个权威位置，其他文档链接过去而不复制长段落。
- 实现后的 proposal 必须删除或缩成仍未实现的部分。
- 文档中的示例必须能对应当前公开入口和 workspace 用法。
