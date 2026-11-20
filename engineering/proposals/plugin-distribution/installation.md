# Host 安装预检与结果跟踪

状态：pnpm 获取、不可变安装与 prepare/confirm 已实现；本页保留 Host 影响、持久结果及制品清理的设计。上级：[提案总览](README.md)。

当前 API 与默认策略见 [Package Manager 用法](../../../docs/plugins/package-manager.md)；来源核对、私有 revision、候选失效、部分发布结果与离线维护由[内部设计](../../../plugins/package-manager/DESIGN.md)维护。

## 发行身份与 Host 身份

升级预检必须遵守现有 [Plugin identity](../../PLUGIN_IDENTITY.md)：registry、版本、摘要和安装路径不参与运行身份。安装同名包的新发行替换实现，不能通过目录或 fork 让同一公开身份的两个实现并存。

一次包升级可能改变多个 Plugin 导出。影响检查应覆盖同包全部 definition、default/fork、被移除的导出与相关依赖。应用固定 import 已拥有同名包时，报告装配来源冲突并定位项目依赖，不用托管安装暗中替代。

## 插件依赖与普通 npm 依赖

现有获取引擎已经选择 pnpm，来源、认证和普通依赖求解继续沿用它的原生行为。新的预检应从[静态 manifest](package-format.md)取得 Plugin 引用，再向实际 Host 核对 provider、共享模块与能力。

required Plugin、optional integration、宿主共享服务和普通实现依赖分别处理。安装服务的 npm 包不代表服务已装配；optional provider 不因市场存在就自动安装或启用。预检不能自行扩大固定 Context。

代表验证仍需覆盖公共/受保护来源、传递依赖和 peer context。当前 pnpm 来源一致性检查是已有能力；受保护市场读取所需的消费者权限由[客户端设计](market-client.md)拥有。

## 两种消费方式

新的发布 manifest 应由同一真实 tarball 在项目依赖与长驻 Host 两条路径消费。项目依赖和锁文件变更由项目构建部署负责；Host 安装记录和 wrapper 发布由 Package Manager 负责，运行接纳由 Host/Core 负责。

现有 source 已区分 live 与 next-start，见[动态来源](../../../docs/host/configuration.md#动态来源)。后续操作结果应继续保留这项差别；保存安装选择不能提前表示目标 Plugin 已启用。

## 安装与升级的预检

当前预览绑定安装选择 revision、私有候选及精确字节，展示受管包图变化。尚缺 Host 的全包影响与提交前状态核对：

- 来源冲突、共享 provider 版本、缺少能力与无法满足的 peer。
- 替换或移除的 Plugin definition、对应节点，以及 Host/Core 判断需要处理的依赖。
- 安装选择、启用意图与实际接纳分别会怎样变化，是否需要新进程。

安装器读取声明和 Host/Core 的实际状态，不复制运行图。需要确定 Host 对外提供的最小预检接口及状态版本，确认时由各所有者核对前提；并发升级或配置变化使计划失效时，返回冲突并重新准备。

验收要覆盖一个含多个 Plugin 的包、被移除的导出、required/optional provider 和应用固定 import。准备之后改变 Host 状态，旧计划应被拒绝，不能默默扩大确认范围。

## 运行与结果所有权

当前安装返回 wrapper 的实际发布结果，候选保存在内存中。若要求跨断线或重启跟踪，需要设计独立、持久的操作回执，将固定发行、保存结果、Host 接纳结果与诊断连接起来；这项能力尚未实现。

准备失败、部分 wrapper 发布、已保存待应用、旧代停止后新代启动失败分别表达。回执查询沿用原操作身份，不能通过重新安装推测前一次是否完成。生命周期由 [Core](../../CORE_LIFECYCLE_SEMANTICS.md)拥有，不能承诺跨脚本、文件和外部副作用的原子回滚。

## 卸载、降级与旧制品

现有卸载撤回公开 wrapper，保留业务数据与旧 revisions/slots。进一步提供完整卸载预检时，需由 Host/Core 判断同包节点、required 阻塞与 optional 变化；保存移除选择、定义撤回、节点停止和制品删除分别报告。

当前没有自动 GC。若需要清理旧制品，必须先取得安装选择、进行中操作和执行器引用的释放证据；无法确认时保留。业务配置和数据清理由其所有者提供独立操作。

降级仍是一次固定发行的安装与接纳。旧 tarball 可用不证明数据库迁移或外部写入可恢复。验收至少覆盖旧实现仍被引用、只能下次启动生效，以及新代 init 失败的情况。
