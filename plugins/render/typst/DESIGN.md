# Typst 文档运行时设计

`@pluxel/typst` 是 workspace 内的 private 插件。公开调用、输入契约与预算由[用法文档](../../../docs/plugins/rendering/typst.md)维护。

## 边界

业务在输入前验证数据。核心只内置 JSON 编码，其余格式接受用户已编码的文本、字节或真实文件；文件表同时表达逻辑路径与来源，没有额外 Schema、Codec 或输入声明层。

Template 是普通 root/entry 配置。Session 固定本地模板和字体快照，串行接纳完整文件表，持有最新成功产物并负责清理。应用拥有通信与归档，Preview 只消费产物。

## 执行路径

```text
open → 固定本地模板与可移植字体
update → session 队列 → 共享 Worker admission → 准备动态文件
       → 单次 native compile → 同 document 导出 Vector/PDF → 发布成功修订
exportPdf → 校验 revision → 返回独立 PDF 副本
close → 撤销接纳 → 等待执行结算 → 清理私有资源
```

共享 Workers 不提供线程亲和的长驻 native session。每个任务独立创建 compiler，PDF 在 update 中生成；session 保存产物，不承诺增量编译缓存。此路线使用现有共享调度，不建立插件私有线程池。

Workers 的 `settlement: 'execution'` 保证任务结果在执行结算后交给资源所有者，包括取消和 owner stop。线程退出无法确认时保留文件并报告清理失败。原生全局缓存按年龄清理，不由 session dispose 清空。

## 资源与修订

模板在 open 复制一次；动态输入在 admission 后写入 staging，准备完成再替换 inputs 目录。文本/JSON 分块编码，文件走磁盘复制或 copy-on-write clone，Worker 消息只传路径和小型配置。逻辑完整替换不要求输入原样经过跨线程 clone。

每次任务返回有界 Vector/PDF 与诊断。成功替换当前修订；失败保留旧产物。exportPdf 在调用时取得对应 PDF 引用，后续更新不影响该导出。关闭、调用方停止和 provider 替换共用幂等清理。

固定范围是本地模板目录、动态文件与可移植字体。上游系统字体及 Typst 包加载仍是部署环境输入，不宣称完整可复现或安全沙箱。

## 实现入口与验证

| 文件                   | 职责                            |
| ---------------------- | ------------------------------- |
| src/index.ts           | Plugin、配置、依赖与 owner 归属 |
| src/session.ts         | 会话队列、修订、取消与文件寿命  |
| src/resources.ts       | 路径、编码、快照与输入预算      |
| src/worker.ts          | native 编译、双导出与诊断       |
| src/browser/preview.ts | 浏览器渲染、过期结果与释放      |

验证覆盖资源边界、session 状态、真实 Plugin lowering/Worker artifact、浏览器 Renderer 和包入口。性能结论以代表性输入测量为准，不把资源字节上限作为 native 内存保证。
