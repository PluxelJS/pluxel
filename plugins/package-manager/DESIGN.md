# Package Manager 安装与恢复

`PackageManagerPlugin` 在 Node 宿主中解析 npm 包并发布 ESM 入口。`PackageManagerConfig` 定义部署策略；持久化的 `published-installation.json` 记录当前选中的安装。Host 只消费发布的入口，Workbench、Commands 和本地插件方法共用同一个 store。目录来源、兼容性检查、级联安装和查看器见[插件市场设计](../../engineering/PLUGIN_MARKET.md)。

## 准备与确认

`prepareInstall` 和 `prepareMarketInstall` 用 pnpm 物化完整依赖图。每个 store 最多保留一份内存预览，有效期为十分钟。预览绑定候选目录、基础 revision、精确版本、SRI 和文件摘要。确认时重新核对候选字节并提交，跳过再次下载和运行构建脚本。停止插件、替换候选或提交其他安装变更都会使旧预览失效。

预览按实际要发布或补发的 wrapper 检查影响，也计入待撤回的旧入口。安装器从实际包的 `pluxel.control` 读取并校验清单快照，只用本包根入口声明推算导出变化。Host 提供已接纳定义的来源、默认节点和 fork 的运行状态，以及 Core 已解析的直接 required/optional 消费者。无清单、其他包的重导出、多个来源共用和来源未报告的定义分别保留未知变化。应用固定 import 已拥有同名包，或候选声明的定义已由本次发布之外的动态来源提供时，准备和立即安装都返回 `SOURCE_CONFLICT`。独立 store 的 `plan.hostImpact` 和 `plan.dependencyReview` 均为 `null`。

控制清单的可选文件 `dependencies.json` 由编译器从本代 lowering 生成，每个可判定的具体定义记录包含 Part 的 required/optional 引用、提供的抽象 token 及可判定的 fork 能力。安装器按清单核对该文件的长度与摘要。缺文件或摘要错误会拒绝声明了该文件的制品；早期清单和未能静态判定的定义允许正常审阅，明确报告缺失项。

Host 将整批候选根声明与保留的来源合并，在同一已提交快照上运行与接纳共用的策略求解。它保留当前 auto-start、会话意图、fork、provider default 和 consumer override。`dependencyReview` 比较策略选中节点的 required 绑定及新增、解除的协调问题，能定位间接受阻的消费者。对尚未启用的候选也列出预计目录中没有 provider 的 required 和 optional 引用。来源归属、依赖或当前 fork 的支持情况不确定时，返回 `incomplete` 和原因；角色冲突返回 `invalid`。`liveRejections` 使用在线接纳的同一判据。若列表非空，按这些声明在线替换会保留原 catalog。候选包首次重导出的外部定义不在自有根清单中，可能改变预测中的缺项、绑定或拒绝原因，只有加载入口时才能发现。

目标 Host 接纳制品并执行节点生命周期。同一份插件依赖声明可以对应不同的启动结果。例如 Otel 根据节点配置决定是否向 `ElysiaApp` 注册 Prometheus 路由。启动时缺少所需服务会进入该节点的生命周期报告，Workbench 在安装审阅中指出查询位置。[Otel 预览与启动对照](../../engineering/records/host-deployment.md#otel-安装预览与启动2026-11-25)

确认先复核候选字节，在原子保存安装选择的 rename 提交前，同步复核 catalog/policy revision 和相关节点、依赖、来源。过期或事实改变返回 `INVALID_PLAN`。Host 正在处理或已排队的图变更返回 `HOST_GRAPH_BUSY`，本次候选释放。若另一个入口在审阅期间损坏，修复需要扩大原范围，此时返回 `INVALID_PLAN`。保存成功后只操作审阅过的入口，回执按包核对实际发布或撤回结果。保存之后的来源接纳、节点启动或阻塞继续由 Host 报告。[Host 来源事实](../../engineering/HOST.md)

pnpm 负责 registry、凭据、代理和下载。默认忽略构建脚本、允许列表为空，最短发布时间为 24 小时。启用脚本时需显式列出可运行脚本的包名，准备阶段就可能执行这些脚本。受管请求支持 npm 包名及版本、范围或 dist-tag。[公开配置和调用方式](../../docs/plugins/package-manager.md)

## 不可变安装与发布

每次安装在私有的 `revisions/<uuid>` 下写入 manifest、lockfile、node_modules 链接和内部入口。pnpm 全局虚拟存储位于 `slots/`，通过复制导入包字节。包图指纹包含 pnpm v9 锁文件中的 resolution、peer、optional 和可达依赖，另对实际文件计算摘要。图和字节都未改变的包复用原物理目录和内部入口，保证不同顶层插件借用同一个依赖实例。无法验证依赖图、已复用目录的字节或路径发生变化时，发布失败。[安装实现](src/store.ts)

保存新的安装记录后，store 逐项原子替换 `entries/` 下的公开入口。确认回执的 `succeeded` 限于成功的请求包，`published` 与 `withdrawn` 报告审阅范围内达到目标状态的入口，包括其他包的入口修复及待撤回项。保存前失败时两个入口列表均为空；保存后若部分发布失败，store 逐个读取审阅过的入口，只有与安装记录一致的发布或撤回项才进入对应列表。快照只为与当前记录一致的包返回 `entryFile`。卸载后仍待撤回的入口由目录内容推导为 `pendingRemovals`；重试这些入口只需撤回文件。旧 revision、slot、资源和制品保留到离线维护，以便已有进程完成工作。

## 写者与生命周期

初始化先用 `requirePluginSource` 核对部署的来源目录。store 通过原子创建 `.writer` 获得跨进程写权限；已有写者时返回 `PACKAGE_STORE_WRITER_CONFLICT`。启动会核对安装记录、路径边界、内部入口、slot 字节和公开入口。异常退出留下的锁由操作者离线核实并清除。原生引擎调用前还会核对调度环境中的首个非空 workspace-dir 与实际安装目录，避免写入调用方的工作区。

初始化、安装变更与快照共用串行队列。调用时捕获请求，卸载时在写队列里核对审阅的 revision。每个 Workbench 文档拥有自己的查询和 RPC 资源，关闭文档后已接纳的安装继续执行。插件关闭时拒绝新操作，等待已接纳的原生安装和写锁释放。发布成功表示入口已就绪，Vite 的即时接纳、原生宿主的下次启动和插件运行状态分别由 Host 报告。

## 验证入口

[Store 测试](tests/store.test.ts)覆盖图变化、预览失效和部分发布恢复。[不可变安装测试](tests/immutable-installation.test.ts)用真实 registry 归档、pnpm slot 和生产 Vite 检查共享实例、入口更新和制品。[原生引擎测试](tests/pnpm-engine.test.ts)验证新进程对发布和撤回的接纳；[环境隔离测试](tests/workspace-environment.test.ts)验证 workspace-dir 覆盖的优先级及隔离。
