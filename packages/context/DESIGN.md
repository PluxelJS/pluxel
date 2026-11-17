# Context 服务内核

公开用法见[组合 Context host](../../docs/reference/context-hosts.md)。内核是同步、host-neutral 的固定服务集合，Plugin graph、服务准备和清理由上层拥有。

## 安装与读取

`installRootService`、`installScopeService`、`installOwnerViewService` 生成不可变安装项。Host 在创建 root 前编译唯一安装计划，按服务身份拒绝重复声明，并为 root/scope/owner cache 分配数字 slot。所有公共读取只走 `ctx.service`，没有属性投影或另一套 lookup API。

服务 class 是声明，不执行 constructor。纯 Context Host 以对象身份定位；Pluxel 上层在安装前将 canonical entry + named export 绑定为稳定 key。首次安装固定声明身份，后续不得改 key；安装前创建的可选引用仍可跟随后续绑定。生成必需描述符与可选 ServiceRef 定位同一安装项。可选引用只在未安装时返回 undefined；访问、构造失败和无效引用仍失败。

root 安装每 root 一份，仅 root 可直接读取；scope 安装与 child 共享，owner-view 使用 root backing 和每个 Context 自己的 owner cache。工厂严格惰性，失败清除未完成 slot 并保留原错误，重试不会读取半成品。undefined 不属于合法构造结果，其他 falsy 值保持原值并缓存。

## 所有权

Context shape 和安装计划固定，不提供运行时注册或安装。Part 的 logger/effects 等既有 owner 值通过 framework internal 的 construction-only `initializeContextServiceValues` 绑定：只允许首次任何服务解析前一次初始化，必须引用已经安装的服务，不能改变访问范围。caller Context view 继承该固定归属，其他 owner-view cache 仍独立。

共享 backend 不通过可变 ctx 表示调用者；owner facade 可缓存并跨 await 使用。Context 不管理资源，Host 和 Plugin generation 的原有生命周期负责准备、排空与释放。

## 验证

测试覆盖 root/scope/child/view、Host/root 隔离、必需/可选查找、身份冲突、访问控制、构造失败与重试、owner backing、显式替换和初始化值。`bench/context.bench.ts` 分开记录服务热读取、owner 首次读取和计划/Context 创建成本；historical comparison 仅作历史算法对比，不提供兼容入口。
