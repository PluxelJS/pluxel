# 依赖补丁

补丁由根 `pnpm-workspace.yaml` 的 `patchedDependencies` 与 lockfile 固定，使用原生
[`pnpm patch` / `patch-commit`](https://pnpm.io/cli/patch) 维护，不修改安装目录。

## ZenFS 准入

固定 `@zenfs/core@2.8.3` 与 `@zenfs/dom@1.2.14`，对应本目录的两个补丁。
当前装配和资源边界见 [Host 文件系统](../engineering/FS.md)，公开用法见
[插件文件存储](../docs/plugin-development/fs.md)。

修复落在原有实现的所有者处：

- Passthrough 完成合法短读、短写，区分 buffer offset 与 file position，处理空覆盖截断，保留独占创建权限和失败原因。
- StoreFS 的 Map undo 保存首次修改前的完整字节，隔离可变 buffer，提交成功后更新路径索引。原生事务转交 commit/abort，不叠加模拟回滚；损坏 inode 明确失败，非空存储缺少根记录时不重建目录，保留原数据。同步初始化无法枚举 keys 时返回 EAGAIN。
- IndexedDB 以原生 `complete` 为提交屏障，事务局部 cache 在完成后发布；abort、请求错误及同步异常保留 errno/cause。初始化失败和部分获取失败关闭连接。
- `SharedConfig.readOnly` 复用 Readonly 操作实现；打开、空写、截断、元数据和已打开句柄执行同一只读边界。缺失的只读 IndexedDB profile 返回 ENOENT，不创建数据库。
- `BoundContext.dispose()` / `Symbol.asyncDispose` 释放自有句柄与 context 引用；`umountAsync()` 等待 cache flush 并释放挂载与 cache，StoreFS/IndexedDB `close()` 释放自有后端。这些操作各自幂等，context 与卸载不接管借用 backend。

关闭顺序为 context dispose → 可等待卸载 → backing close。每一步收集错误后继续释放后续资源；调用方仍须等待自己启动的 IO。补丁不增加全局写队列、业务 commit callback、新 FS facade 或事务引擎。

## 发布分发

根 `patchedDependencies` 不会传递给独立安装者。Services 因而内联这份修复后的原生实现、运行时闭包和声明；`/fs` 与 `/fs/browser` 导出的 backend 和内部准备路径使用同一模块实例，不依赖消费仓库配置 patches，也不接受另行安装的未修复 backend 对象。

来源、固定版本、上游源码、许可证和构建方法由 [Services 发布来源记录](../packages/services/third-party/README.md)维护。构建将这份记录、原始 manifest/notices 和两个补丁复制到 `dist/third-party`；升级或移除补丁时同步复核闭包。没有新增 fork 包或后端协议。

## 回归入口

在 `packages/services` 目录执行：

```sh
mise exec -- vp test run tests/zenfs.test.ts tests/zenfs-store.test.ts tests/fs.test.ts
mise exec -- vp run check-types
mise exec -- vp run check-zenfs-browser
# 先构建，再检查真实 tarball；不使用工作区 source 条件。
mise exec -- vp test run --config tests/installed.config.mts -t 'ships the patched filesystem'
```

浏览器入口连接现有 `PLAYWRIGHT_WS_ENDPOINT`，缺省 `ws://127.0.0.1:3000`；只关闭自己的 context 并断开连接，不安装、启动或关闭共享浏览器。HTML 与浏览器 bundle 由 Playwright route 交付，无额外开发服务；该 task 禁用缓存。

原版红基线已用相同操作和结果断言校准：短写落盘为 `NE`，StoreFS 32 个注入场景中 26 个破坏回滚，IndexedDB write/rename 返回时事务尚未完成，preload 失败泄漏连接，损坏 root 假成功。正式机制回归消费 pnpm 安装的包，无临时源码 alias；独立发布回归另从工作区外安装 tarball，验证 Node、真实浏览器、owner 隔离、关闭重开、只读及 `types: []` / `skipLibCheck: false`。

验收覆盖完整、空、二进制文件、公开 promises 并发、多 profile、只读、初始化失败及重复创建/关闭。Map store 对 create、truncate、write、unlink、link、rename 的每个底层修改点注入失败，检查当前与重开后的字节和目录。IndexedDB 的 abort、请求错误及配额错误针对临时文件 rename 替换，检查旧文档保留。

这不承诺普通 `writeFile` 的整操作原子性。配额用真实事务 abort 和 `QuotaExceededError` 注入，未实际填满浏览器配额；不据此宣称断电 fsync、多进程一致性、Windows 或全部 Node FS API 兼容。升级依赖时先重跑原版反例，再删除已经上游修复的补丁。
