# Typst 文档运行时设计

`@pluxel/typst` 是 workspace 内的 private 插件。公开调用、输入契约与预算由[用法文档](../../../docs/plugins/rendering/typst.md)维护。

## 边界

业务在输入前验证数据。核心只内置 JSON 编码，其余格式接受用户已编码的文本、字节或真实文件；文件表同时表达逻辑路径与来源，没有额外 Schema、Codec 或输入声明层。

Template 是普通 root/entry 配置。Session 固定字体快照，串行接纳完整输入文件表与可选模板树替换，持有最新成功产物并负责清理。应用拥有通信与归档，Preview 只消费产物。

## 执行路径

```text
open → 快照本地模板与可移植字体 → 分配有界 session
update → session 队列 → 准备动态文件 / 可选模板替换
       → session 专用 Worker → 复用 NodeCompiler、同步 shadow VFS delta
       → 同 document 导出 Vector/PDF/源码与标题坐标 → 发布成功修订
renderPage → 同 session 队列 → 校验 retained revision → bounded PNG / pixel crop（不编译）
exportPdf → 校验 revision → 返回独立 PDF 副本
close → 撤销接纳 → 终止专用线程并确认退出 → 清理私有资源
```

NodeModules 负责正式构建制品定位和替换生命周期；每个 session 至多一个独立 Worker，maxSessions 是线程上限。通用 Workers 没有线程亲和契约，因此此有状态计算不借用无状态任务池。

Worker 保留 NodeCompiler、最新成功 document 与文件内容索引；同一私有文件快照中未变化的文件不重复读取，变更调用 mapShadow、删除调用 unmapShadow。每次 compile resetRead 刷新读取缓存，native memoized 计算仍保留；evictCache 按年龄清理，不代表 native RSS 硬上限。字体变化由调用方关闭并重开 session，避免同名字体缓存串扰。

取消在途 native 计算需要终止线程并关闭会话，不能在已销毁线程上继续更新。调用方可重新 open。普通编译诊断不关闭会话；修复源码后可在原会话继续。无法确认退出时保留目录并报告 EXECUTION_UNSETTLED。

原生绑定固定 typst.ts 源码版本，使用本包 `native/` 中可审查的最小补丁暴露 `NodeTypstDocument.navigation()` 与 `renderPage()`。它直接遍历本次 document 的 frame/span 和 introspector；不建立第二个编译器、语言服务或业务监听端口。构建产物由包携带，Node worker 按包位置加载，不修改 node_modules。

## 资源与修订

模板在 open 复制，update.template 可提交完整替换；动态输入在 session 排队后写入 staging，准备完成再替换 inputs 目录。文本/JSON 分块编码，文件走磁盘复制或 copy-on-write clone，Worker 消息只传路径和小型配置。逻辑完整替换不要求输入原样经过跨线程 clone。

每次任务返回有界 Vector/PDF、源码定位信息与诊断。成功替换当前修订；失败保留旧产物。exportPdf 在调用时取得对应 PDF 引用，后续更新不影响该导出。关闭、调用方停止和 provider 替换共用幂等清理。

固定范围是本地模板目录、动态文件与可移植字体。上游系统字体及 Typst 包加载仍是部署环境输入，不宣称完整可复现或安全沙箱。

## 实现入口与验证

| 文件                   | 职责                            |
| ---------------------- | ------------------------------- |
| src/index.ts           | Plugin、配置、依赖与 owner 归属 |
| src/session.ts         | 会话队列、修订、取消与文件寿命  |
| src/resources.ts       | 路径、编码、快照与输入预算      |
| src/native-client.ts   | 专用线程、取消及退出结算        |
| src/worker.ts          | native 编译、同修订导出与诊断   |
| src/native-binding.ts  | 包内固定 NAPI 制品加载          |
| native/                | 原生补丁与可重复构建            |
| src/browser/preview.ts | 浏览器渲染、过期结果与释放      |

验证覆盖资源边界、session 状态、真实 Plugin lowering/Worker artifact、浏览器 Renderer 和包入口。性能结论以代表性输入测量为准，不把资源字节上限作为 native 内存保证。
