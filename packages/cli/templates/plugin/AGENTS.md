# Coding agent 工作入口

开发 Pluxel 应用或插件前先使用 [pluxel-development skill](.agents/skills/pluxel-development/SKILL.md)，由 skill 指导工具选择、开发服务、日志和在线操作；只按当前任务展开其引用文档。

入口缺失时：Git 用户从上游 checkout 的 CLI 执行 `source install --root <本项目>`；npm 用户安装依赖后执行 `vp exec pluxel workspace setup`。`vp exec pluxel docs` 可直接读取当前来源的正文。CLI 管理生成链接，不复制或提交上游正文。

日常修改用 `vp run check-tests tests/<file>.test.ts` 运行相关测试文件。按风险补充类型检查或消费应用的回归。`vp run verify` 用于完整验收。报告实际结果与未验证边界。在线效果使用现有 dev console 验证。

## 本包构建与检查

- 修改插件、公共契约、package metadata、`tsdown.config.ts` 或 lint / fmt 规则前，按开发指南确认对应契约；包发布见 `vp exec pluxel docs development/plugin-package.md`。
- `tsdown.config.ts` 只描述包的输入输出；`pluxel build` 拥有编译语义与生成的插件依赖 metadata。

工作区使用全局 Vite+ 统一依赖安装与命令执行；`mise.toml` 仅提供可选的工具安装与版本固定。命令约定与应用、插件及团队模板共同遵循工作区工具链指南。准备好工具后运行 `vp install`、`vp run setup`，已有 Git 仓库再 `vp run hooks:install`。`hk.pkl` 只选择文件并调用 `vp check`；`vp run verify` 委托 `workspace:verify` 原生任务图。`oxlint.config.ts` 与 `oxfmt.config.ts` 分别维护规则，根 `vite.config.ts` 引用为 `lint` / `fmt` 并启用类型检查；每份规则只维护一个来源，详见工作区工具链指南。

独立插件没有可运行应用，不声明空的 `pluxel.dev` 或启动临时 Host。在线调试时用 `--root` 从消费应用目录发现配置，显式 `--profile` 优先于应用 default，没有默认且多 profile 时必须指定；匹配实例仍有多个时使用 `--instance`。没有配置的手动 Vite 可用 `--root` 指定其真实根目录。操作与 receipt 恢复方式由 skill 和开发控制台指南维护。

消费应用运行时，跨文件或连续修改按指南的「HMR 批次控制」使用 `dev hmr pause` → 修改与检查 → `dev hmr apply` → 验证。失败保持暂停；成功且原本 auto 才恢复，不为独立插件测试另起应用。

项目和上传脚本统一使用 `satisfies Script`（`@pluxel/agent-sdk/host`），通过 `sdk.ctx` 使用内建能力，通过 `sdk.ctx.service(Service)` 借用应用安装的服务。控制操作直接 `await` 成功值，失败抛 `ScriptError`；业务实例用 `const { instance } = await plugin.instance()` 借用。调用、失败恢复和资源释放见 `vp exec pluxel docs development/scripts.md`，项目模块与 HMR 操作见 `vp exec pluxel docs development/dev-console.md`。配置修改后核对保存结果与实际采用。

插件地址、控制材料同步、配置类型和业务实例调用见 `vp exec pluxel docs development/plugin-control.md`。完整调用由这些随 CLI 交付的指南维护。

源码查询见 `vp exec pluxel docs development/inspection.md`。从 `@pluxel/agent-sdk/source` 导入普通查询函数，通过 Node 直接发现、定位源码；指定 root/application，不启动应用。Host 脚本类型和直接操作入口从 `@pluxel/agent-sdk/host` 导入。

## 持久状态与原生依赖

配置继续使用 `configs.use()`。配置之外的有界状态通过固定的 `ctx.tinybase.open()` 取得每个 Plugin node 唯一的托管 Store；原生 API 和类型直接从 `tinybase` 与上游子路径导入。持久位置、恢复和保存归 Host，不在插件管理 Persister 或另写 JSON 设置。密钥通过固定的 `ctx.vault` 访问，后端由 Host 的 `coreConfig.vault` 配置；大文件通过固定的 `ctx.fs()` 保存；后端只在 Host 的 `coreConfig.zenfs` 中选择。

共享托管 Store 的包使用 catalog 所选的精确 `tinybase` peer 与同版 dev dependency；Core 内建精确 TinyBase runtime；应用仅在直接使用原生 TinyBase 时声明自己的 dependency。`pluxel build` 生成 `pluxel.tinybase` 接纳事实，不手写标记或使用全局 override。仅使用配置的包不需要新增 TinyBase import。独立私有 Store 保留普通依赖与自身解析；开始交换宿主托管 Store 后再进入共享契约。完整用法见 `vp exec pluxel docs development/plugin-package.md`。

终端命令与普通 Node 调用的选择见 `vp exec pluxel docs development/agent-sdk.md` 的「终端命令」；项目脚本继续使用原有 SDK 类型。
