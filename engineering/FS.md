# Host 文件系统

公开用法由[插件文件存储](../docs/plugin-development/fs.md)和 [Host 后端选择](../docs/host/configuration.md#选择文件后端)维护。本页定义 Services 的资源边界、实现入口与验证责任。

## 唯一接线与准备

`@pluxel/services/fs` 提供 `fs(config)`、root-only `Fs` 和 owner-only `PluginFs`。`FsServiceConfig` 只接收固定的 InMemory、Node Passthrough、浏览器 IndexedDB 后端声明；每个 Host 创建自己的实例，不接受共享的已打开 FileSystem、任意 mount graph 或业务自建 Store。

`PluginFs` 及可选 `ctx.fs` 返回异步目录访问函数，调用后取得 `FsPromises`，即 ZenFS `BoundContext['fs']['promises']`。Context capability 构造与取得访问函数无 IO；没有第二套文件 facade 或 locator。构造与准备均不读取 Host config。

`FsService` 由 root 拥有，第一次异步文件或文档操作与服务 `prepare` 共用一个 `readyPromise`。Host 读取配置早于普通服务 prepare，因此 `documents(path)` 是同步纯适配：首个文档操作自行等待同一准备任务，不另加 early-prepare 阶段。准备失败保留原 rejected 结果，不隐式重试。

`ready(requirement?)` 与 `directory(path, requirement?)` 在 IO 前检查需求：InMemory 的 durable 要求返回 `ENOTSUP`，只读配置的 writable 要求返回 `EROFS`。实际写操作仍由后端执行只读约束。未知配置项与非法目录输入明确拒绝，不修剪或修复输入。

## 数据与目录所有者

| 数据              | 固定目录                    | 领域责任                                    |
| ----------------- | --------------------------- | ------------------------------------------- |
| Host 配置、图策略 | `host/config`、`host/state` | Host 保留文档编码、revision、确认与 flush   |
| Vault             | `services/vault`            | 加密、身份、key envelope、KV、blob 与事务锁 |
| Logging policy    | `services/logging`          | profile 编码、pending flush 和错误状态      |
| Management layout | `services/management`       | 校验、串行修改和 RPC 失败回执               |
| Plugin node       | `plugins/<physicalKey>`     | 插件业务自己的文件格式、并发和发布顺序      |

physical key 使用唯一 `PluginNodeAddress` canonical bytes 的 SHA-256；包含 fork，排除 generation、display name、包版本和安装路径。Node 与浏览器使用同一可移植摘要实现。Part 共用所属 Plugin 目录，目录缓存不持有 Plugin、Part 或 generation Context。停止、HMR 和 fork 删除不隐式清理持久数据。

文件目录固定绑定数据所有者；Wretch 的 consumer 设置仍存放在 provider 目录，并保留完整 consumer owner envelope。FS 不接管 Vault、Cache、Fonts 等领域的身份验证、预算和 revision。

## Host 文档与关闭

`configRecords.storage`、`state.storage` 唯一形式为同步 `(root: RootContext) => HostDocumentStorage`，在 root 创建后、任何文档 IO 前各解析一次并校验。FS 接线为 `root => root.require(Fs).documents('host/config')`；外部嵌入应用也可返回原有借用适配，不转交连接所有权。省略 storage 时仍为内存，不因安装 FS 自动持久化。

`HostDocumentStorage` 仅含 `getText(key)`、`put(key, text)`、`stat(key)`。`put` 无条件要求完整原子提交后才 resolve，不接收可选 atomic 标记。只有确实缺失返回 `undefined`；损坏内容保留原文件并失败。Logging 的 `policyStore` 同样是同步 root factory，经 `createPluginLogPolicyStore(root.require(Fs).documents('services/logging'))` 借用文档接口。

FS 清理注册到 `root.effects` 的 `final` 阶段；config/state 与领域服务先排空自己的写入，再关闭目录 context、卸载实例并关闭后端。构造或准备失败仍进入同一清理路径，多项清理失败聚合报告。调用方必须等待自己的文件操作并释放 FileHandle、watcher 和任务；不对裸 FS 引用施加 generation Proxy，不承诺关闭后仍可使用借用对象。

## 完整提交与发布边界

`writeFileAtomic()` 只做确保父目录、同目录独占创建临时文件、完整写入并关闭、rename 替换。临时文件权限为 `0o600`；失败保留原始错误和清理失败，不走 `rm(dst)` 再 rename 的降级。它不提供 fsync、多文件事务或全局 writer 队列。

ZenFS 的定向修复集中在固定版本依赖补丁，业务不包含事务或缓存补偿实现。Services 构建内联这份后端闭包，复制原始 notices、manifest 与补丁到产物；仅在根目录配置 pnpm patches 不会把修复传给独立安装者。独立 tarball 验证必须经过公共 `/fs`、`/fs/browser` 入口并证明无需外部未补丁的 ZenFS 安装，不能以工作区 source 测试替代接收方验证。

原生日志 file sink、数据库 driver、源码与制品加载，以及 Typst CAS 不从该文件服务反推磁盘路径，也不改为通用虚拟文件层。浏览器存储不承诺跨设备同步、跨进程 writer 协调或断电保证。

## 实现与验证入口

- `packages/services/src/fs.ts`、`fs/token.ts`：公开 token、无 IO capability 与安装声明。
- `packages/services/src/fs/service.ts`、`fs/atomic.ts`：准备、目录、文档适配、提交与 final 清理。
- `packages/services/src/internal/plugin-address.ts`：唯一物理 key；`packages/host/src/document-storage.ts`：Host 借用契约。
- `packages/services/tests/zenfs.test.ts`、`zenfs-store.test.ts`、`zenfs.browser.mjs`：真实短读写、事务 abort/配额、只读、根损坏与回收。
- FS/Host、Vault、Logging、Management、Cache、Fonts、Wretch 测试：首读与 prepare 共享实例、坏数据不覆盖、提交后发布、关闭前 flush、fork/generation 归属和跨 Host 恢复。

新增后端或升级依赖时重新验证实际提交与释放边界。真实浏览器页面/Worker 的 IndexedDB 和工作区外安装结果必须分别记录；API 形状相似与 mock store 不能证明这些结果。

2026-10-30 的独立安装、在线接收方、数据转换及未验证边界见[实施验收记录](proposals/ZENFS_FS_REFACTOR.md#验收证据)。当前实现不包含旧路径读取器或启动迁移；已有部署需要按实际数据格式显式转换，保留原副本并验证领域恢复。
