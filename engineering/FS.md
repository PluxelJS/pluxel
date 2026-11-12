# Host 文件系统

公开用法由[插件文件存储](../docs/plugin-development/fs.md)和 [Host 后端选择](../docs/host/configuration.md#选择文件后端)维护。本页定义 Core 内建文件能力的资源边界、实现入口与验证责任。

## 唯一接线与准备

每个 Core 固定提供 `PluginContext.fs()`，返回所属 Plugin node 目录的 ZenFS 原生 promises API。没有 FS token、可选 Context service 或安装器；root 不提供 Plugin 业务目录。

`CoreHostConfig.zenfs?: FsConfig` 是唯一文件系统装配输入。应用推荐使用 `runtime.zenfs: zenfs(nativeConfig)`（`@pluxel/core/config`）：helper 同步复用 `snapshotFsConfig`，验证并快照声明、正规化 mount key，省略根挂载时补 InMemory；不 create、ready 或执行 IO。Core 仍接受原生配置。

输入沿用 ZenFS 的 `Configuration` / `MountConfiguration`：`mounts` 的值可以是原生 `Backend`、带 backend 自身 options 的配置，或已经打开的 `FileSystem`；支持多个挂载和原生 nested backend options。省略整个配置或根挂载时，每个 Core 创建独立的 InMemory 根。没有后端名称或 constructor identity 白名单。

`@pluxel/core/fs` 提供 InMemory、Passthrough、原生配置类型和原子保存；浏览器 IndexedDB 从 `/fs/browser` 导入。外部后端正常使用其依赖的 `@zenfs/core`，不要求继承 Core 内联副本的 class。FileSystem 通过原生方法、attributes 和 uuid 的结构契约接纳；后端自己的 options 校验继续由原生 `checkOptions` 执行。已知后端 options 的编译期精确校验可使用 `BackendConfiguration<typeof Backend>`，或 `FsConfig<{ '/': typeof Backend }>`；默认开放配置不伪造对未知后端 options 的推导。

组合 backend 如果在内部要求 `FileSystem` 的 SDK 实例身份，其子层应来自同一份 SDK；例如外部 `CopyOnWrite` 搭配同一 `@zenfs/core` 的 `InMemory`。这样的完整组合可以与 Core 预设放在不同 mount，Core 不改写外部 class 的身份检查。

Core 使用每个 root 的独立 `BoundContext`、credentials 和 mount table，不调用修改 ZenFS 全局默认态的 `configure()`。原生 `uid`、`gid`、`readOnly`、`disableAsyncCache`、`caseFold`、`defaultDirectories`、`addDevices` 保留在装配输入中；`log`、`disableAccessChecks`、`resolveFullWalk` 在固定版本里修改模块级状态，不能逐 Core 隔离，因此不属于 `FsConfig`。`onlySyncOnClose` 在该版本没有实现，也不接纳为有效配置。这里排除的是具体全局或未实现行为，不限制 backend 自身的 options。上游定义见 [Configuration](https://zenfs.dev/core/configuration/) 与 [Security](https://zenfs.dev/core/security/)。

访问函数与内部文档 factory 不执行 IO。第一次异步文件或文档操作共享同一个准备任务；准备失败保留原 rejected 结果，不隐式重试。装配复制原生声明，不原地替换调用方的 nested config。Passthrough 保留上游语义：`prefix` 目录由应用显式创建，Core 不猜路径或 mkdir 宿主前缀。Core portable 入口不静态加载 Node 或浏览器持久后端，也不依赖 Host 或 Services。

`durableMounts?: readonly string[]` 是应用对具体已声明 mount 的跨重开持久性断言；省略为 `[]`。它不是按 backend 名称推测的检测结果，也不承诺 fsync、断电或多 writer 协调。`ready(requirement?)` 是显式检查整棵装配；Plugin Store open 只检查自己的 snapshot 目录，Host put 只检查实际文档目录，无关只读挂载不阻挡可写目标。`directory(path, requirement?)` 与 `ctx.fs(requirement?)` 检查绑定目录实际路由的 mount 及其子 mount：未声明持久性的任一覆盖 mount 使 durable 要求以 `ENOTSUP` 失败；实际 readonly / no_write attributes 使 writable 要求以 `EROFS` 失败。准备完成后才可可靠检查 backend 的实际 attributes，实际操作继续执行原生只读约束。

## 创建、借用与失败回收

通过 Backend/config 创建的每个 FileSystem 在返回时立即登记为 Core 所有；nested 层和随后失败的 mount 也在回收范围内。最终先释放 BoundContext 的子目录和句柄，排空并移除私有 mount cache，再按创建逆序释放资源；释放协议依次选择 `Symbol.asyncDispose`、`close()`、`Symbol.dispose`。组合 backend 与 Core final 共享同一次释放，纯同步释放入口仍同步抛出原错误。后端在 `create()` 返回前自行取得而尚未交出的资源仍由该后端负责回滚。原生 options 中传入的 channel、fetcher、Node fs module 等不自动转移给 Core。

直接提供 FileSystem 表示借用；Core 不关闭它。每个 Core 对借入实例建立独立 VFS attributes/cache view，使顶层 readOnly/caseFold 等选项不会改写原实例，关闭也不会移除另一 Core 正在使用的 cache。组合 backend 收到的借用子层也隔离 `close()`、`Symbol.asyncDispose` 与 `Symbol.dispose`，不通过父层回收释放源实例。业务方法仍以原实例为 receiver，保留第三方 class 的私有字段。借入资源的创建者应在所有借用结束后关闭它，并在借用期保持其配置和寿命稳定；这不额外提供共享后端的跨 Core writer 协调。

准备、mount-point 检查、同步或关闭失败保留原异常；只有 ENOENT 能进入创建缺失挂载目录的分支，不吞权限或 IO 故障。部分装配失败立即回收已取得资源；准备错误和回收错误同时出现时聚合保留。不会用一个新内存后端或重新打开后端伪装恢复。

## 数据与目录所有者

| 数据               | 固定目录                          | 领域责任                                                   |
| ------------------ | --------------------------------- | ---------------------------------------------------------- |
| TinyBase snapshots | `services/tinybase/nodes`         | Plugin Store 的恢复、预算、保存和故障由 TinyBase 拥有      |
| Host documents     | `services/host/<namespace>/<key>` | config/state/logging/management 各领域拥有格式与确认后发布 |
| Vault              | `services/vault`                  | 加密、身份、key envelope、KV、blob 与事务锁                |
| Plugin node        | `plugins/<physicalKey>`           | 插件业务自己的文件格式、并发和发布顺序                     |

physical key 使用唯一 `PluginNodeAddress` canonical bytes 的 SHA-256；包含 fork，排除 generation、display name、包版本和安装路径。Node 与浏览器使用同一可移植摘要实现。Part 共用所属 Plugin 目录，目录缓存不持有 Plugin、Part 或 generation Context。停止、HMR 和 fork 删除不隐式清理持久数据。

文件目录固定绑定数据所有者；Wretch 的 consumer 设置与 Fonts 偏好已由 [TinyBase](TINYBASE.md) 承载，不再属于 Plugin 文件目录。FS 不接管 Vault、Cache、Fonts 等领域的身份验证、预算和 revision。

## Host 文档与关闭

Host 默认从 Core 内部 `requireHostDocuments(root, namespace)` 借用 `config` 和 `state` 文档，所选 backend 只在 `runtime.zenfs` 中输入。嵌入应用仍可通过同步 root factory 提供已有借用适配；不转交连接所有权。将 `runtime.documents.config` 或 `runtime.documents.state` 设为 `false` 可关闭对应领域的文档 IO。

`HostDocumentStorage` 定义在 Core，Host 保留原名 re-export，包含 `getText(key)`、`put(key, text)`、`stat(key)` 与可选的 namespace 变化订阅 `subscribe(listener)`。`put` 等待完整原子提交，不接收可选 atomic 标记。只有确实缺失返回 `undefined`；损坏内容保留原文件并失败。Vault 使用内部 `requireFs(root)` 获取自己的目录；Logging 与 Management 使用同一普通文档入口。FS 只限制普通文档单文件 8 MiB（UTF-8），不解释领域编码；TinyBase snapshot adapter 使用自己的 maxSnapshotBytes。原子写失败保留原生错误，结果可能未知，由领域 owner 决定发布与恢复。

Core 统一在 root final 中先关闭所选日志运行时，再排空 TinyBase Plugin writers 与 FS 文档并关闭后端；Host config/state 与 Services 领域服务先排空自己的任务。FS 文档在首次 subscribe 时观察已访问 key，新访问 key 加入同一订阅；最后一个订阅取消即停止观察，关闭等待在途观察与所有已接纳读写。普通读取不会启动观察。构造或准备失败仍进入同一清理路径，多项清理失败聚合报告。调用方必须等待自己的文件操作并释放 FileHandle、watcher 和任务；裸 promises 不增加 generation Proxy，关闭后不能继续使用借用对象。

## 共享文件与观察

后端决定文件是否由多个 Host 实际共享；配置文本相同不建立共享关系。FS 不复制数据，不选择 writer/replica，也不协调跨实例修改。TinyBase 与 Vault 读取各自文件并负责校验、刷新和通知；普通 Host 文档由 FS 提供内容变化订阅，Host 配置负责 v4/Plugin schema 接纳与运行中应用。state 只在启动时读取，不因外部写入自动改变运行图。

内部 `fs/observe.ts` 以 250 ms 间隔异步读取内容，前一次读取及处理未结束时不重叠执行。字符串与字节内容相同不重复通知；相同的无效内容不反复接纳，读取错误在恢复成功读取前只报告一次。取消会停止后续读取并排空正在处理的工作。它不依赖 ZenFS 进程内 `watch()` 事件，也不承诺跨后端零延迟或每个中间文件版本都可见。

## 完整提交与发布边界

`writeFileAtomic()` 只做确保父目录、同目录独占创建临时文件、完整写入并关闭、rename 替换。临时文件权限为 `0o600`；失败保留原始错误和清理失败，不走 `rm(dst)` 再 rename 的降级。它不提供 fsync、多文件事务或全局 writer 队列。

ZenFS 的定向修复集中在固定版本依赖补丁，业务不包含事务或缓存补偿实现。Core 构建内联这份后端闭包，复制原始 notices、manifest 与补丁到产物；仅在根目录配置 pnpm patches 不会把修复传给独立安装者。独立 tarball 验证必须经过公共 `/fs`、`/fs/browser` 入口并证明无需外部未补丁的 ZenFS 安装，不能以工作区 source 测试替代接收方验证。

原生日志 file sink、数据库 driver、源码与制品加载，以及 Typst CAS 不从Core 文件能力反推磁盘路径，也不改为通用虚拟文件层。浏览器存储不承诺跨设备同步、跨进程 writer 协调或断电保证。

## 实现与验证入口

- `packages/core/src/fs.ts`、`fs/browser.ts`：公开后端、配置与原子保存类型。
- `packages/core/src/fs/config.ts`：原生配置、隔离挂载、创建/借用与失败回收。
- `packages/core/src/fs/service.ts`、`fs/documents.ts`、`fs/atomic.ts`：目录、需求检查、文档适配与原子提交。
- `packages/core/src/internal/storage.ts`：固定 owner handle、物理 key 与内部 Host 资源入口。
- `packages/core/src/storage/documents.ts`：Host 借用文档契约。
- Core FS/TinyBase、Host、Vault、Logging、Management、Cache、Fonts、Wretch tests：短读写、事务 abort/配额、只读、根损坏、提交后发布、关闭前 flush、fork/generation 归属与跨 Host 恢复。

新增后端或升级依赖时重新验证实际提交与释放边界。真实浏览器页面/Worker 的 IndexedDB 和工作区外安装结果必须分别记录；API 形状相似与 mock store 不能证明这些结果。

后端回归从 [ZenFS](../packages/core/tests/zenfs.test.ts)、[StoreFS](../packages/core/tests/zenfs-store.test.ts)、[浏览器验收](../packages/core/tests/zenfs.browser.mjs)进入。已有浏览器配额证据来自事务 abort 与 `QuotaExceededError` 注入，未实际填满配额；Windows、Cloudflare 持久后端和 DO 文件系统尚无验收结论。

已有部署需要按实际数据格式显式转换，保留原副本并验证领域恢复；当前实现不包含旧路径读取器或启动迁移。文件路径转换与领域格式恢复分别检查，不能把未识别的历史配置或布局自动启用。Core 固定能力的迁移范围与有日期的执行记录见 [TinyBase 迁移清单](TINYBASE_MIGRATION.md)。
