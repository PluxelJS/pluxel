# 工程不变量

修改框架时先用本页检查设计，再读 [Plugin 系统](PLUGIN_SYSTEM.md) 理解执行路径；领域规则从 [工程导航](README.md) 按任务选读。本页只保存跨领域约束，具体 API、实现位置和验证由领域文档拥有。

## 一个事实，一个所有者

- Core 拥有 Plugin graph、generation、配置事实与 lifecycle report；Host 拥有 catalog、运行意图、持久策略和进程集成。来源、服务、管理面与 UI 消费这些事实，不复制 graph 或 lifecycle。
- Context 是同步、host-neutral 的固定能力 kernel，不拥有 IO、prepare/dispose 或 Plugin graph。Host 在 root 创建前完成服务组合；Plugin 不在模块求值或 `init()` 中追加、替换 capability。
- 依赖方向按实际模块和求值入口判断。基础能力不加载上层组合、未选择的 backend 或构建工具；包级相互引用不能替代模块和资源所有权审查。完整规则由 [GOVERNANCE](GOVERNANCE.md) 维护。
- 同一语义保留一个公开入口。当前服务于本地仓库：修改契约时同步更新已知调用者，不为假设中的外部消费者保留 alias、旧格式 reader 或启动迁移。必要的数据转换一次完成，随后移除转换代码。

## 声明必须给出可验证的事实

- Plugin 身份来自 canonical entry 与唯一 root named export；展示名称、class name、constructor identity 和物理目录不参与身份。
- required dependency 由 constructor 声明；optional integration 观察 catalog，不暗中加载、安装或改变 provider 启动策略。普通逻辑、Part containment 与独立 Plugin graph 各有边界，见 [Plugin 作者模型](PLUGIN_SYSTEM.md#plugin-作者模型)。
- 工具链在 TypeScript 擦除前生成声明事实，route 在 namespace 求值完成后消费 frozen candidate。缺少或不兼容的事实必须明确失败，不通过 reflection、命名约定或运行时猜测恢复。
- 原生 SDK 的契约、decision、receipt 和 lifecycle failure 保留原义。调用者可恢复的本地领域失败显式建模，见 [Better Result](../docs/api/better-result.md)。不能把“已保存”“已提交”“已运行”混为成功。

## 所有权必须经得起缓存和并发

- 每个资源只有明确的创建者与释放者；资源获取成功后立即登记幂等 cleanup。借用者不关闭共享 backend、listener 或 root。
- logger、gate、effects 与 registration 固定 owner Context。共享 registry 不通过可变的“当前 ctx/caller”识别调用者；缓存 handle、并发初始化、Part occurrence 与异步 callback 都不能改变归属。
- 已知成员和 owner 语义优先用普通对象、class 或预编译 descriptor 表达。成员真正开放，或 Proxy 比 codegen、显式 `invoke()`、预编译 descriptor 更清楚时，可以使用 Proxy，但必须保持反射、identity、调试与生命周期语义并记录取舍；浏览器 type-erased RPC stub 是当前实例。
- Context shape 编译后不可变。每次 Plugin generation 对应一个 kernel scope；该代的 Part child 与 dependency caller view 共享 scope backing，但各有 owner-view cache。不另设全局上下文协议。

## 生命周期只发布真实结果

- provider 先启动、后停止；required failure 只阻塞 dependent closure。`init()` 无法提供能力时必须失败，不能只记日志后半启动。
- `init()` 返回的 cleanup 与显式登记资源进入同一 generation effects；replacement、rollback、optional restart、stop 和 shutdown drain 同一套资源。
- 停止先关闭 admission，再 abort、等待已接纳操作并 drain。旧 admission 关闭后不能把旧 instance 冒充成可回滚快照；晚到结果不得重新发布失效 generation。
- 验证候选与发布事实分开。不可变候选先完成校验；可见状态在所属领域的 commit 边界切换，失败按真实阶段报告。Core 提供 lifecycle facts，宿主决定退出、告警或降级。

## 可选能力关闭即无运行成本

- disabled capability 不安装 Context property，不创建 backend、compiler、watcher、route、transport 或持久状态；不以有状态空服务模拟成功注册。
- optional callback 未执行时，Plugin 仍能完成核心生命周期。业务状态和业务 API 不依赖可选 Workbench。
- Workbench 启用后遵守固定 Cap’n Web/WebSocket、MF2 Manifest/Snapshot 与 React Bridge 契约；Content-only definition 无 renderer，按其专属零 MF 路径运行。关闭整个 Plane 与削弱已启用能力的契约是不同决定。

## 证据应覆盖改动所在边界

| 改动                             | 最少应核对的证据                                                           |
| -------------------------------- | -------------------------------------------------------------------------- |
| 作者 API、公开类型或导出         | 当前用法、public exports、已知 workspace 调用者与真实调用示例              |
| DI、metadata、源码接纳           | semantic lowering 与真实 Vite Module Runner；raw runner 不代表 Plugin 入口 |
| Context、service 或 handle       | 多 owner、缓存 handle、并发、撤回与 cleanup 归属                           |
| 可选能力                         | enabled/disabled 两条路径，尤其 disabled 零初始化                          |
| lifecycle、commit 或 publication | provider failure、dependent blocking、replacement、late result 与 teardown |
| 包入口、构建或发行               | 真实发布入口、独立安装与搬离 workspace 的制品验证                          |

先在最小仍承载风险的边界验证，具体测试入口由领域文档及 [TESTING](TESTING.md) 给出。删除设计后搜索旧符号、入口与链接。在线应用的当前事实只能通过既有 [devconsole](../docs/development/dev-console.md) 检查，隔离测试不能证明它。

## 当前文档不承担历史记录

`docs/` 拥有公开用法，`engineering/` 拥有架构约束与实现入口，`.agents/rules/` 提供通用决策指南。未实现方向进入 `proposals/`，历史由 Git 和标明范围的证据记录保存。公开行为变化同步更新用法；文档只说明当前契约，不留下第二套兼容教程。
