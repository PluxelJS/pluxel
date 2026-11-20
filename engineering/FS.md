# Host 文件系统

配置了文件能力的 Core 通过 `ctx.fs()` 返回所属 Plugin node 目录的 ZenFS promises API。Part 共用 owner 目录，root 不提供 Plugin 业务目录。Cloudflare 请求 Host 使用独立内存文档，`ctx.fs()` 以 `ENOTSUP` 拒绝。公开调用见[插件文件存储](../docs/plugin-development/fs.md)，装配见 [Host 后端选择](../docs/host/configuration.md#选择文件后端)。

## 唯一接线与准备

应用的 `coreConfig.zenfs` 和直接 Core 的 `zenfs` 使用 `FsConfig` 接收原生 ZenFS 声明。Core 同步校验并快照输入，正规化 mount key，在缺少根挂载时选用 InMemory。访问文件系统时才准备后端。省略配置时每个 Core 拥有独立内存根。

mount 接受原生 Backend、BackendConfiguration 和已打开 FileSystem，支持多挂载及 nested backend options。`@pluxel/core/fs` 提供 InMemory、Passthrough、配置类型和原子保存；IndexedDB 从 `/fs/browser` 导入。外部 backend 以方法、attributes、uuid 的结构接纳，原生 checkOptions 继续校验自身参数。需要编译期精确校验时使用 `BackendConfiguration<typeof Backend>` 或 `FsConfig<{ '/': typeof Backend }>`。

组合 backend 自身要求 SDK instance identity 时，其子层应来自同份 SDK，例如 CopyOnWrite 与其 InMemory；完整组合可与 Core backend 并列挂载。

每个 root 有独立 BoundContext、credentials 和 mount table，不调用 ZenFS 全局 configure。uid/gid/readOnly/disableAsyncCache/caseFold/defaultDirectories/addDevices 保留；当前上游版本的 log、disableAccessChecks、resolveFullWalk 修改模块全局状态，因此不属于 FsConfig，未实现的 onlySyncOnClose 也不接纳。backend 自身 options 保留。上游语义见 [Configuration](https://zenfs.dev/core/configuration/) 和 [Security](https://zenfs.dev/core/security/)。

取得 API/内部 document factory 不执行 IO。首次异步操作共享准备任务，失败固定为原 rejected 结果。快照不改写调用方 nested config。Passthrough prefix 由应用创建，Core 不猜测宿主目录。portable 入口不静态加载 Node/浏览器持久后端，也不依赖 Host/Services。

`durableMounts` 是应用对已声明 mount 的跨重开持久性断言，默认 `[]`；它不从 backend 名称推断，也不增加 fsync 或 writer 协调。`ready(requirement?)` 检查整棵挂载，`directory(path, requirement?)` / `ctx.fs(requirement?)` 只检查目标目录实际覆盖的 mount/submount。未声明 durable 的覆盖 mount 使持久要求以 ENOTSUP 失败，实际 readOnly/no_write 使 writable 要求以 EROFS 失败。attributes 在准备后检查，实际操作仍执行原生限制；无关只读挂载不阻挡目标写入。

## 创建、借用与失败回收

Backend/config 创建的 FileSystem 一返回即登记为 Core 所有，含 nested 层和后续 mount 失败前已取得的资源。最终释放 BoundContext 句柄/目录、排空并移除私有 cache，再逆序释放 backend，协议依次为 asyncDispose、close、dispose。组合 backend 与 Core final 共用一次释放，同步入口保留同步错误。create 返回前取得的资源由 backend 回滚，channel/fetcher/Node fs 等原生参数不自动转移所有权。

传入 FileSystem 只借用。每个 Core 建立独立 VFS attributes/cache view，readOnly/caseFold 不改原实例，关闭不移除其他 Core cache。借用 nested layer 同样隔离释放协议，业务方法仍以原实例为 receiver，保留第三方私有字段。创建者在全部借用结束后关闭，并在借用期保持配置/寿命稳定。

只有 ENOENT 触发创建缺失 mount 目录，其他 prepare/mount/check/close 错误原样保留。部分装配立即清理，准备与清理错误聚合；失败不换成内存 backend 或隐式重开。

## 数据与目录所有者

| 数据           | 固定目录                          | 领域责任                       |
| -------------- | --------------------------------- | ------------------------------ |
| TinyBase       | `services/tinybase/nodes`         | Store 恢复、预算、writer、保存 |
| Host documents | `services/host/<namespace>/<key>` | 各领域格式和确认后发布         |
| Vault          | `services/vault`                  | envelope、身份、KV/blob、锁    |
| Plugin         | `plugins/<physicalKey>`           | 业务格式、并发、发布顺序       |

physicalKey 为 canonical node bytes 的完整 SHA-256，包含 fork，排除 generation/displayName/version/安装路径。Node/浏览器共用摘要算法。目录缓存不保留 Context。停止、HMR、fork 删除保留数据，FS 不解释领域 revision 或预算。Fonts 偏好使用 TinyBase。 [TinyBase](TINYBASE.md)

## Host 文档与关闭

`requireHostDocuments(root, namespace)` 借用当前 Core 的文档存储。Node 与浏览器将 namespace 映射到原有 ZenFS 目录。Cloudflare 请求 Host 按 root 保存内存文档，省略外部变更观察。`config.document` 和 `policy.document` 接受同步 root factory，也可分别设为 `false` 以关闭对应的文档 IO。

Core 定义 `HostDocumentStorage`，Host 原名 re-export：getText、put、stat 和可选 subscribe。put 等待完整原子提交；仅真正缺失返回 undefined，坏内容保留原文件。普通文档单文件预算为 UTF-8 8 MiB，TinyBase snapshot 自有预算。原子写失败可能已发生提交，领域 owner 决定后续发布/恢复。

内建 Vault 通过 requireFs 按需使用自身目录，Logging、Management 与受管出站 HTTP 借用普通文档。Host 与 Services 先排空各自操作；Core 在关闭文件系统前完成 Vault 的观察释放与 flush、日志和 TinyBase writers 的结算，最后关闭 FS 文档和 backend。首次 subscribe 才观察已访问 key，新 key 加入同一订阅，最后一次取消停止观察；普通 read 不启动观察。关闭等待在途观察和全部已接纳读写，构造/prepare 失败也走同一清理路径。

caller 等待自己的文件操作，并释放 FileHandle、watcher、任务；原生 promises API 没有 generation Proxy，关闭后不能继续使用借用对象。

## 共享文件与观察

实际 backend 决定跨 Host 是否共享文件；FS 不复制数据或协调 writer。TinyBase/Vault 各自校验和接纳文件，Host config 接纳 v4/schema 并通知 generation，state 只在启动读取。

`fs/observe.ts` 每 250 ms 异步读取内容，前次读取/处理结束后才进行下一次。相同 string/bytes 不重复通知，相同坏内容不反复接纳；读取错误在恢复前只报告一次。取消停止后续读取并排空当前工作。观察不依赖进程内 watch，不保证每个中间版本可见。

## 完整提交与发布边界

`writeFileAtomic()` 确保父目录，在同目录独占创建 0o600 临时文件，完整写入/关闭后 rename。失败保留原错误及临时文件清理错误，不先删除目标。不提供 fsync、多文件事务或全局 writer queue。

ZenFS 修复集中于固定版本依赖补丁。Core 构建内联 backend 闭包及原 notices/manifest/补丁，独立 tarball 必须从 `/fs`、`/fs/browser` 验证，不依赖消费者另装未补丁 ZenFS。

原生日志 file sink、数据库、源码/制品 loader、Typst CAS 保持各自路径与 IO 模型。浏览器 backend 的同步/持久能力按实际环境验证。

## 实现与验证入口

- `packages/core/src/fs.ts`、`fs/browser.ts`：公开配置与 backend。
- `fs/config.ts`：挂载隔离、创建/借用、失败回收。
- `fs/{service,documents,atomic,observe}.ts`：目录需求、文档、提交、观察。
- `internal/storage.ts`、`storage/documents.ts`：owner key、Host 内部资源和借用接口。

回归从 [ZenFS](../packages/core/tests/storage/zenfs.test.ts)、[StoreFS](../packages/core/tests/storage/zenfs-store.test.ts)、[浏览器验收](../packages/core/tests/storage/zenfs.browser.mjs) 开始，覆盖短 IO、abort/配额、readonly、坏根、确认后发布、关闭 flush、fork/generation 和跨 Host 恢复。真实页面/Worker IndexedDB 与独立安装各自验收；现有配额证据是 abort/QuotaExceededError 注入，Windows/Cloudflare 持久后端/DO 文件系统尚未验收。

已有数据转换由显式维护工具备份、校验并原子提交，启动不猜测旧格式或启用旧配置。迁移范围和有日期记录见 [TinyBase 迁移清单](records/plugin-state-adoption.md)。
