# Coding agent 工作入口

开发 Pluxel 应用或插件前先使用 [pluxel-development skill](.agents/skills/pluxel-development/SKILL.md)，由 skill 指导工具选择、开发服务、日志和在线操作；只按当前任务展开其引用文档。

入口缺失时：Git 用户从上游 checkout 的 CLI 执行 `source install --root <本项目>`；npm 用户安装依赖后执行 `vp exec pluxel workspace setup`。`vp exec pluxel docs` 可直接读取当前来源的正文。CLI 管理生成链接，不复制或提交上游正文。

完成修改后运行 `vp run verify`，报告实际检查结果与未验证边界；在线效果需要现有 dev console 的实际证据。

## 本包构建与检查

- 修改插件、公共契约、package metadata、`tsdown.config.ts` 或 lint / fmt 规则前，按开发指南确认对应契约；包发布见 `vp exec pluxel docs development/plugin-package.md`。
- `tsdown.config.ts` 只描述包的输入输出；`pluxel build` 拥有编译语义与生成的插件依赖 metadata。
- 完成后运行 `vp run verify`；不得无理由绕过 Pluxel lint 规则。

工作区默认使用 mise 固定 Node、pnpm、Vite+ 和 hk；先 `mise trust`、`mise install`、`vp install`、`vp run setup`，已有 Git 仓库再 `vp run hooks:install`。`hk.pkl` 只选择文件并调用 `vp check`；`vp run verify` 委托 `workspace:verify` 原生任务图。`oxlint.config.ts` 与 `oxfmt.config.ts` 分别维护规则，根 `vite.config.ts` 引用为 `lint` / `fmt` 并启用类型检查；每份规则只维护一个来源，详见工作区工具链指南。

独立插件没有可运行应用，不声明空的 `pluxel.dev` 或启动临时 Host。在线调试时用 `--root` 从消费应用目录发现配置，显式 `--profile` 优先于应用 default，没有默认且多 profile 时必须指定；匹配实例仍有多个时使用 `--instance`。没有配置的手动 Vite 可用 `--root` 指定其真实根目录。操作与 receipt 恢复方式由 skill 和开发控制台指南维护。

消费应用运行时，跨文件或连续修改按指南的「HMR 批次控制」使用 `dev hmr pause` → 修改与检查 → `dev hmr apply` → 验证。失败保持暂停；成功且原本 auto 才恢复，不为独立插件测试另起应用。

项目脚本使用普通 TypeScript 函数与 `satisfies ProjectScript`（`@pluxel/host-vite/project`），通过 `sdk.dev.address/instance/ctx` 访问当前模块图。通用 SDK 为 `Script`（`@pluxel/host/agent`），方法返回普通 Promise；配置修改后核对领域报告与实际采用。部署上传执行、认证与 receipt 见 `vp exec pluxel docs development/scripts.md`。

`pluxel build` 同时生成 `./control` 描述符、class 成员类型和配置 Schema 源码描述。作者安装原包及公开类型依赖后可使用 `sdk.plugins.instance(descriptor)` 调用实际业务方法；运行中应用的材料用 `pluxel dev sync` 或 `pluxel script sync` 获取。先 await 业务方法，再做配置或生命周期操作。用法见 `vp exec pluxel docs development/plugin-control.md`。

## 持久状态与原生依赖

配置继续使用 `configs.use()`。配置之外的有界状态通过固定的 `ctx.tinybase.open()` 取得每个 Plugin node 唯一的托管 Store；原生 API 和类型直接从 `tinybase` 与上游子路径导入。持久位置、恢复和保存归 Host，不在插件管理 Persister 或另写 JSON 设置。密钥留在 Vault，大文件通过固定的 `ctx.fs()` 保存；后端只在 Host 的 `runtime.zenfs` 中选择。

共享托管 Store 的包使用 catalog 所选的精确 `tinybase` peer 与同版 dev dependency；Core 内建精确 TinyBase runtime；应用仅在直接使用原生 TinyBase 时声明自己的 dependency。`pluxel build` 生成 `pluxel.tinybase` 接纳事实，不手写标记或使用全局 override。仅使用配置的包不需要新增 TinyBase import。独立私有 Store 保留普通依赖与自身解析；开始交换宿主托管 Store 后再进入共享契约。完整用法见 `vp exec pluxel docs development/plugin-package.md`。
