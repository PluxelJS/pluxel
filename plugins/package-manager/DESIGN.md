# Package Manager 安装与恢复

`PackageManagerPlugin` 在 Node 宿主中解析 npm 包并发布 ESM 入口。`PackageManagerConfig` 定义部署策略；持久化的 `published-installation.json` 记录当前选中的安装。Host 只消费发布的入口，Workbench、Commands 和本地插件方法共用同一个 store。目录来源、兼容性检查、级联安装和查看器见[插件市场设计](../../engineering/PLUGIN_MARKET.md)。

## 准备与确认

`prepareInstall` 和 `prepareMarketInstall` 用 pnpm 物化完整依赖图。每个 store 最多保留一份内存预览，有效期为十分钟。预览绑定候选目录、基础 revision、精确版本、SRI 和文件摘要。确认时重新核对候选字节并提交，跳过再次下载和运行构建脚本。停止插件、替换候选或提交其他安装变更都会使旧预览失效。

pnpm 负责 registry、凭据、代理和下载。默认忽略构建脚本、允许列表为空，最短发布时间为 24 小时。启用脚本时需显式列出可运行脚本的包名，准备阶段就可能执行这些脚本。受管请求支持 npm 包名及版本、范围或 dist-tag。[公开配置和调用方式](../../docs/plugins/package-manager.md)

## 不可变安装与发布

每次安装在私有的 `revisions/<uuid>` 下写入 manifest、lockfile、node_modules 链接和内部入口。pnpm 全局虚拟存储位于 `slots/`，通过复制导入包字节。包图指纹包含 pnpm v9 锁文件中的 resolution、peer、optional 和可达依赖，另对实际文件计算摘要。图和字节都未改变的包复用原物理目录和内部入口，保证不同顶层插件借用同一个依赖实例。无法验证依赖图、已复用目录的字节或路径发生变化时，发布失败。[安装实现](src/store.ts)

保存新的安装记录后，store 逐项原子替换 `entries/` 下的公开入口。I/O 可能在两项之间失败，回执按实际文件报告 `succeeded` 和 `failed`。快照只为与当前记录一致的包返回 `entryFile`。卸载后仍待撤回的入口由目录内容推导为 `pendingRemovals`；重试这些入口只需撤回文件。旧 revision、slot、资源和制品保留到离线维护，以便已有进程完成工作。

## 写者与生命周期

初始化先用 `requirePluginSource` 核对部署的来源目录。store 通过原子创建 `.writer` 获得跨进程写权限；已有写者时返回 `PACKAGE_STORE_WRITER_CONFLICT`。启动会核对安装记录、路径边界、内部入口、slot 字节和公开入口。异常退出留下的锁由操作者离线核实并清除。原生引擎调用前还会核对调度环境中的首个非空 workspace-dir 与实际安装目录，避免写入调用方的工作区。

初始化、安装变更与快照共用串行队列。调用时捕获请求，卸载时在写队列里核对审阅的 revision。每个 Workbench 文档拥有自己的查询和 RPC 资源，关闭文档后已接纳的安装继续执行。插件关闭时拒绝新操作，等待已接纳的原生安装和写锁释放。发布成功表示入口已就绪，Vite 的即时接纳、原生宿主的下次启动和插件运行状态分别由 Host 报告。

## 验证入口

[Store 测试](tests/store.test.ts)覆盖图变化、预览失效和部分发布恢复。[不可变安装测试](tests/immutable-installation.test.ts)用真实 registry 归档、pnpm slot 和生产 Vite 检查共享实例、入口更新和制品。[原生引擎测试](tests/pnpm-engine.test.ts)验证新进程对发布和撤回的接纳；[环境隔离测试](tests/workspace-environment.test.ts)验证 workspace-dir 覆盖的优先级及隔离。
