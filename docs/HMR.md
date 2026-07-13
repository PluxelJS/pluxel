# HMR Architecture

HMR replacement 必须保持 core lifecycle、Management resources 和 UI artifact 同步：

```text
module batch -> committed graph -> stop old owner/effects -> start new owner
             -> mount module/resources -> compile artifact -> Management revision
             -> Workbench refetch target layouts -> lazy load new remote
```

`ManagementCompilerService` 位于 `packages/runtime-dev/src/management/`，dynamic/static route 只负责提供
Vite server、plugin directory 和 host policy。旧 artifact 可短暂保留在磁盘供 inflight import 完成，但旧
layout bindings 在 revision 变化后立即失效。

测试至少覆盖 module replacement cleanup、compile error state、cached artifact、target layout refresh 和
disabled Management Plane。
