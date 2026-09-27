# 严格契约与可定位失败：实施提案

状态：待实施的设计提案，不是当前 API 规范。基线为 `0b0f42ed` 加当前工作区的 Workbench 故障修复；2026-09-27。
本轮仅审查源码并制定迁移边界，不修改运行应用或持久数据。以下“已确认”指控制流存在，不代表所有场景已现场复现。

## 决策标准

严格的是声明与执行结果的一致性，不是报错数量。

- 缺省可以采用有文档的默认值；显式无效值不能退回默认值。
- 不存在、内容损坏、权限不足、版本不兼容和内部异常必须能区分。
- 框架不能通过删除配置、换实现、猜入口或跳过包，让错误输入看似成功。
- 合法用法所需的模块单例、取消传播、资源释放仍由框架保证，不转嫁给应用。
- 不为严格化添加一组 `strict` / `legacy` / `compat` 开关；按现有契约一次迁移所有已知调用方。
- 静态声明在检查或构建阶段验证；依赖 IO、身份和资源的事实在接纳边界验证。不能为提前报错而提前执行有副作用的 factory。

## 全项目适用范围：事实唯一，行为可预测

本提案覆盖 Core、Host、Services、CLI、编译/发行工具与应用装配。Workbench 是暴露问题的案例，不是严格契约的唯一消费者。共享原则是“声明、执行、报告一致”，不是所有依赖都使用 peer、所有状态都立即持久化，或所有失败都终止进程。

| 事实 | 权威来源与边界 | 应消除的隐式行为 | 验证入口 |
| --- | --- | --- | --- |
| 包成员、版本与发布集合 | workspace/catalog、package inventory、各包发布清单各拥有自己的事实 | 各工具猜成员、另维护版本表、把传递安装当作声明 | S02/S04；治理与发行检查 |
| 配置与环境 | Host 官方 env 解析；各领域 schema 与已有来源追踪 | 各入口重复默认值、改变优先级、读取时机不同却声称是同一有效配置 | S06；比较 CLI/开发/发行入口的解析结果 |
| 路径与目标 | 明确的 workspace root、deployment root 或绑定的 owner | 用当前 cwd 重新解释已绑定路径、把缺失目标换成另一个目标 | S02/S03/S06；改变 cwd 后仍定位同一目标 |
| 保存、应用与就绪 | Host 配置回执、生命周期报告、dev discovery | 把排队当完成、已保存当已应用、进程存在当服务就绪 | S01/S08/S09；验证失败阶段与旧实例状态 |
| 资源与可选能力 | 实际 service/owner 的创建、撤回和清理契约 | disabled 仍初始化、失败后留下部分可见资源、自动重试非幂等操作 | 现有生命周期测试；只为已证实缺口建实施项 |
| 编译事实与制品 | 源声明生成 metadata；构建 revision 与最终发布产物 | 手填生成事实、读取旧产物替代失败产物、检查与执行用不同入口 | S04/S05/S10；独立安装与真实消费 |
| 失败与诊断 | 原始失败所属领域；CLI、日志、UI 投影同一事实 | 每层另猜原因、吞掉 cause、笼统提示重装、返回成功却只记错误日志 | S03/S07/S08/S09；一个失败可沿原始 cause 定位 |

这是跨领域审查清单，不是声称每行都有现存缺陷。已确认问题继续进入 S 项；新发现必须附调用链与反例，不能因出现 `catch`、`??`、缓存或异步执行就判为错误。

已有正确设计应直接推广：

- [environment.ts](../../packages/host/src/environment.ts) 已集中解析官方变量；[config-store.ts](../../packages/host/src/config-store.ts) 已记录配置来源。先补遗漏消费者，不另建万能配置中心。明确 env 快照的读取时机，以及变更需要重新解析还是重启；普通业务 env 不机械并入 Host 官方变量。
- [config.ts](../../packages/host/src/config.ts) 已区分 `saved`、`application`、desired/applied revision 与 `persistence_failed`。CLI/UI 应保留这些事实，不压成一个成功布尔值；后台延迟保存可以保留，但不能在尚未落盘时承诺持久完成。
- [系统边界](../PLUGIN_SYSTEM.md) 已定义 owner、generation、可选能力和事务结果。重复安装、同名注册及资源替换按领域明确为拒绝、替换或幂等，不自行套用 last-wins；发现真实不一致再修改实现。

每个对外操作至少能回答：读取哪份输入、默认和覆盖规则是什么、何时完成、失败后哪些事实已改变、下一步改哪里。信息紧邻既有 API/回执/诊断维护，不新增一套重复的全局状态模型。

## 批量维护：优先扩展现有 CLI，不新增平行规则系统

决策：暂不引入 monoman。它适合通用 JSON/YAML/文本的 check/write，但本项目已经拥有 workspace 发现、插件语义事实和清单变更能力；当前缺口是明确的维护入口与安全修复边界。先复用这些实现，不为批量修改 package.json 再建扫描器或通用规则平台。

当前事实：

- [workspace doctor](../../packages/cli/src/commands/workspace.ts) 调用治理诊断，尚无批量修复选项；`workspace scan` 是扫描并记录候选目录，不等于识别插件语义或校验依赖角色。
- [rules/index.ts](../../packages/rolldown/src/cli/rules/index.ts) 已读取、运行规则并写回清单；[plugin-deps.ts](../../packages/rolldown/src/cli/rules/plugin-deps.ts) 根据 `pluginUsages` 移除普通依赖、设置 peer、同步 optional 与生成元数据。它不是对所有 Core import 的角色检查，不能宣称已有全仓 Core peer 修复。
- [plugin-metadata.ts](../../packages/rolldown/src/cli/plugin-metadata.ts) 在构建成功钩子调用这些变更。现有规则按 peer → dev → dependencies 选择版本；这不等于已经检测声明冲突。生成字段与作者维护字段也混在同一写入流程中，需要分清所有权。

拟议入口为 `pluxel workspace doctor` 检查、`--fix` 显式修复、`--fix --dry-run` 预览（尚未实现）；不另建同义 check/repair 命令。实现先形成“文件、字段、当前值、期望值、依据、可否自动修复”的变更计划，再由入口决定展示或写入。CLI 只编排，语义分析和规则复用现有工具链实现，不把领域政策全塞进命令处理器。

| 所有者 | 职责 |
| --- | --- |
| CLI doctor 与共享清单规则 | 成员清单、依赖角色、确定性字段修复；主仓治理入口复用检查 |
| pncat | catalog 与版本引用维护；需要版本选择时不由修复规则猜新版本 |
| Oxlint | 源码 import、内部入口与可静态判断的 API 误用；源码局部 autofix 继续保留 |
| 编译/Host 准入 | 实际版本、制品及运行时身份验证，不执行清单自动修复 |
| Tegami | 发布版本与内部发布依赖更新 |

修复约束：

1. 只处理明确 workspace root 下选定的第一方成员；目录扫描不能自动认定 Plugin，角色来自现有 inventory 或编译事实。独立 local-projects 分别指定 root；不改 vendor、node_modules 或生成发行清单。
2. 确认 Plugin 的共享运行时依赖后，才能把 Core 等声明移到 peer，并按既有政策保留开发副本。最终 Host、普通库及私有实现按自身角色处理，不按包名前缀全量搬字段。
3. 各字段已有不兼容版本、未知角色、失效生成事实时，只报告冲突；不能采用“第一个非空值”覆盖。缺少版本依据时交由 pncat/作者补齐，不取本机偶然安装版作政策。
4. 写入前确认文件未偏离已检查内容，保留无关字段；报告已修复、未修复及原因，修复后重查，剩余错误返回失败。二次执行无差异；多文件中途失败报告实际完成范围，不承诺跨文件原子事务。
5. 普通 build 对作者维护的错误依赖字段报错并指向修复入口，不再顺带搬移。编译生成 metadata 仍由构建更新，但不能据旧生成列表删除另有用途的手写 peer。先拆清现有规则的这两类写入，再迁移调用方。

只有以后发现通用文件同步能通过 monoman 明确删除现有维护代码，才重新评估引入；不让它与 CLI 各写一套包角色、版本或修复规则。

## 收益与范围门槛

仅为可验证的损失增加约束：保护持久数据、防止漏构建/错解析、提前拒绝不可消费制品，或缩短已发生故障的定位路径。每批先给出最小反例；若既有检查已能准确阻止该反例，只补调用接线或说明，不再实现第二套检查。

- S01 的收益是避免覆盖原数据；S02/S03 是避免错误候选与错误修复建议；S04/S05/S10 是把页面阶段故障前移；S06/S07 是阻止错误输入被解释为成功；S08/S09 是直接暴露已有失败事实。
- 检查放在拥有事实的最窄边界。依赖扫描在构建/接纳时执行，不在每次 RPC 或请求时遍历 node_modules；制品完整性在生成/接纳时检查，不逐请求扫描全目录。
- 缓存检查结果必须绑定真实输入或当前构建，清单、解析条件、安装结果和制品 revision 改变后重查；没有性能证据时不增加持久检查缓存。
- 新的恢复命令、公共错误码、配置开关或协议字段必须有具体消费者。S01 首先停止隐式重置并给出人工恢复路径，不要求同时开发通用数据修复工具。

## 执行地图

下文 S 编号保持稳定，作为实施与验收索引；每项证据是定位入口，不代表整包都存在问题。

| 工作 | 所有者 | 最早可靠的拒绝位置 |
| --- | --- | --- |
| S01 持久数据 | Host store | 读取后、覆盖或发布状态前 |
| S02/S03 成员发现与解析 | CLI / Rolldown / Host-dev | 生成候选清单或模块归属前 |
| S04 依赖与身份 | 治理工具、构建工具、Host | 声明检查、构建与运行接纳各守其边界 |
| S05/S10 制品完整性 | Workbench / Rolldown | 构建完成与制品接纳前 |
| S06 显式配置 | 配置所属服务或 CLI | 默认值应用与资源创建前 |
| S07 资源读取 | 静态资源服务 | IO 失败处，转换为准确 HTTP 结果 |
| S08/S09 可定位失败 | Host-dev / Workbench | discovery、操作结果与授权诊断入口 |

## 诊断契约：一次反馈足以采取下一步

每项实施同时交付诊断，不把可定位性留到最后一批。沿用现有错误/日志设施，不新建通用诊断框架。

- **操作与位置**：失败的阶段、包或 node、源文件/清单字段；运行时错误附可关联的诊断标识。
- **期待与实际**：例如支持版本和解析版本、预期入口和缺失 chunk；不只报“无效配置”或 `factory_failed`。
- **影响**：此次接纳失败、旧实例仍服务、应用尚未 ready 或操作未完成；不能让进程存活暗示成功。
- **下一步**：指向应修改的权威输入及随后应重跑的现有检查。无法确定根因时保留 cause 与已知事实，不编造“清缓存/重装即可”的建议。

例如 capnweb 版本不符应同时报告 publisher、peer 字段、Host 支持版本、publisher 原始解析版本/路径，并提示更新该仓库 catalog 和安装结果后重跑检查。同版本身份冲突则指向加载/打包边界，不能仍建议修改版本。

只有调用方需要分支的失败才新增稳定 code；未知异常保留 cause，不用 message 正则猜分类。完整路径与堆栈留在授权的本地诊断，浏览器只获取安全摘要和关联标识；不输出配置原值、凭据或任意 factory props。

## 待实施项

### S01：损坏的持久配置与状态不得在启动时自动重置（P0，已确认）

证据：[config-store.ts](../../packages/host/src/config-store.ts) 的 `loadFromDisk`、`isolateBrokenConfigFile`；[state-store.ts](../../packages/host/src/state-store.ts) 的 `loadFromDisk`、`isolateBrokenStateFile`。

当前：可写模式解析失败会告警、尝试保存 `.broken.*`、重置内容并写回。备份失败仅告警，外层仍继续重置。只读模式反而拒绝启动。状态文件在成功解析后的版本、字段、重复 node 检查已经严格，不能误报为整个 codec 宽松。

重设计：首次不存在允许初始化；已有文件无法解析则拒绝接纳 Host，原文件不变。恢复/重置是显式管理操作，不是启动的副作用；操作必须返回备份与写入的真实结果，备份失败不能继续覆盖。

迁移与验收：调整原有自动恢复测试与文档；覆盖语法损坏、错误根类型、未知版本和首次初始化，断言拒绝后原文件内容未变；仅在保留显式恢复操作时覆盖备份失败不覆盖原文件。模拟损坏不能在真实 local-projects 数据目录进行。

### S02：workspace 只能来自明确声明，不能猜成员或跳过坏清单（P1，已确认）

证据：[workspace/info.ts](../../packages/rolldown/src/workspace/info.ts)、[workspace/manifest.ts](../../packages/rolldown/src/workspace/manifest.ts)、[workspace/fswalk.ts](../../packages/rolldown/src/workspace/fswalk.ts)；CLI 的 [workspace/state.ts](../../packages/cli/src/workspace/state.ts) 使用该信息。CLI 另有同义 [manifest.ts](../../packages/cli/src/workspace/manifest.ts)。

当前：清单解析或读取失败可变为 `undefined`；没有 workspace patterns 时猜 `packages/*` 和 `apps/*`；目录枚举失败可变为空集合。最终发现结果可能是不完整的“成功”。

重设计：项目内明确采用 `pnpm-workspace.yaml` 作为成员权威。单包项目是显式识别的有效情况，不能因目录形状被推断成 monorepo。选中成员的坏 JSON、无权限读取或错误 patterns 必须失败；glob 的合法空匹配和真正不存在分别按命令契约处理。合并重复清单读取实现，缺失可选文件与读取已选文件不是一个 `safeRead` 契约。

验收：坏成员不能从 build/check/publish 候选中消失；未知根目录不能猜成另一个 workspace；只读探索命令如允许部分结果，必须标记不完整，不能交给写操作消费。

### S03：解析器必须保留“无法解析”的原因（P1，已确认）

证据：[resolver/oxc.ts](../../packages/rolldown/src/resolver/oxc.ts) 的 `resolveWithOxc`、`getOxcResolver`；[host-modules.ts](../../packages/host-dev/src/host-modules.ts) 的向上查找清单逻辑。

当前：resolver 初始化异常和解析异常均可能退化成 `null`；初始化失败还会被缓存。清单读取/解析异常可被当作“这里没有 package.json”，继续查父目录。

重设计：正常未命中可以返回空值；非法配置、坏清单、权限和 resolver 内部错误保留 cause，并补 importer、specifier、conditions 和实际清单路径。发现物理 package.json 后，不能因其损坏借用父包的 type/name。先核对 OXC 实际错误分类，再设计局部错误契约，不靠字符串猜错误种类。

验收：分别注入未安装包、坏 package.json、被 exports 拒绝、无权限和无效 resolver 配置，确保调用者不会把它们全部转成“请安装依赖”。

### S04：应用提供共享运行时，库声明 peer，工具链执行准入（P1，待迁移）

证据：[治理约束](../GOVERNANCE.md#依赖与版本) 已按运行时所有权区分 peer 与普通依赖；[workbench-peer.ts](../../packages/rolldown/src/cli/workbench-peer.ts) 已要求 publisher 的 Cap’n Web peer/dev 声明。开发侧 [serviceSingletons](../../packages/services/src/vite.ts) 目前无条件改道 Host 中的 capnweb，尚未先验证 publisher 版本；生产侧 [static-workbench-capnweb.ts](../../packages/rolldown/src/cli/static-workbench-capnweb.ts) 已按 publisher 标记检查版本并统一解析。两条路径需要统一契约，不能把故障修复当作最终架构。

#### 依赖归属：看跨界对象，不看包名

| 使用角色 | 声明与职责 |
| --- | --- |
| 最终 Host 应用 | `dependencies` 安装并提供 capnweb 运行时 |
| Workbench、向它提供 RpcTarget 的插件或基础库 | `peerDependencies` 声明兼容版本，`devDependencies` 提供开发测试副本；发布产物不内联自己的 capnweb |
| 不向 Workbench 传递对象的独立 RPC 模块 | 普通 `dependencies`，不接管其模块解析 |
| 其他实现依赖 | 由使用包直接声明；只有确需消费者提供共享身份或平台的边界才使用 peer |

保留 `import { RpcTarget } from 'capnweb'`，不新增 SDK 再导出或应用 alias。platform-kit 等实际定义 target 的基础库同样属于共享边界，不能只检查插件根包。类型引用本身不决定 peer；不按 `@pluxel/*` 前缀或“高度集成”机械改清单。Elysia 的版本兼容与实例要求应按实际传递的应用/插件对象单独核对，不从 Cap’n Web 的构造器约束推导出同一单例策略。

#### 三个责任，只维护一份兼容事实

1. **pncat 管源码版本声明。** 每个受控 workspace 的外部版本由 catalog 管理，内部链接遵循现有 workspace 规则。独立 local-projects 有各自的 catalog；pncat 不统一跨仓库锁文件、传递依赖或模块实例。检查验证声明结果，不声称证明修改由哪个工具执行；发布清单检查展开后的真实版本，不要求保留 `catalog:`。
2. **准入检查声明与实际安装。** 从 Workbench 的权威兼容约束取得支持版本，publisher 的 peer、开发副本、Host 安装与实际解析结果都必须满足约束。当前先维持已验证的精确版本边界，不凭 semver 范围重叠宣称兼容。已有发布元数据记录构建事实，不另设手写版本表。缺声明、缺安装、不兼容、错误内联均拒绝，不能先改道再检查。
3. **Host 与构建工具保证共享身份。** 通过准入的 Workbench 模块在同一 Host 内使用同一原生 capnweb 实例；开发与生产共用判定规则。相同版本的两个安装路径仍可能产生不同构造器，peer 和去重均不能代替加载接线。复用 Host 原生模块登记；不要求用户处理 Vite/Node 双图。

因此不能把 `serviceSingletons()` 简化成“只检查且删除接线”，也不能保留“任何 capnweb 都强制替换”。实现应为：识别 Workbench 消费边界 → 验证原始声明与解析 → 统一已接纳模块实例。已由 Node 加载、无法接入统一实例的产物必须明确拒绝，不宣称 Vite resolve hook 能改写原生模块的内部 imports。

#### 实施前必须消除的歧义

- **源码构建与发行接纳不同。** 源码构建检查 peer、开发副本及 catalog；发行安装不要求存在 devDependencies 或 workspace 文件，只验证发布 peer、制品事实、宿主安装与实际解析。消费者直接声明运行时，不能靠包管理器自动补 peer 来隐式选择所有者。
- **publisher 标记不等于完整共享边界。** [plugin-metadata.ts](../../packages/rolldown/src/cli/plugin-metadata.ts) 从本包编译结果写入标记；静态接线按 importer 最近清单读取标记。需以“插件发布基础库提供的 target”为反例，证明基础库也被识别；缺标记不能直接证明它是私有 RPC。优先沿用编译事实和实际模块依赖，不要求作者再手写一份名单。
- **同一个包可能同时有共享和私有 RPC。** 当前按包改道不能表达这种差异；先盘点实际调用方。若同一模块的同一个 import 同时用于二者，其运行时就是同一个，不能承诺按用途自动隔离。需要不同版本时通过独立模块/包边界表达，并验证私有依赖未被接管；不添加猜测用途的 resolver。
- **检查必须匹配执行环境。** 当前 peer 检查通过 `createRequire().resolve()`，开发接线使用 Node/import 条件；不同条件可能解析不同入口。验证实际执行入口与模块身份，不能把 require 分支检查通过当作 ESM 分支已验证。此处是待构造双入口反例的覆盖缺口，不宣称 capnweb 已发生该故障。

#### 检查入口与失败位置

| 入口 | 检查内容 | 失败处理 |
| --- | --- | --- |
| Oxlint | 可静态定位的未声明 import、运行源码只声明 dev 依赖、禁用内部入口 | 定位 import 与所属清单字段；builtin、相对路径、合法 alias 不误报 |
| workspace doctor / governance | workspace 成员、catalog 引用、依赖角色及实际安装 | 报清单路径、字段、期待/实际值；主仓和 local-projects 复用检查逻辑 |
| publisher build / Host 接纳 | peer 兼容、原始解析版本、发布元数据与共享模块接线 | 接纳前失败；不静默升级、安装或替换不兼容版本 |
| target 创建后的注册边界 | 实际 RpcTarget 身份、新实例和 owner 生命周期 | 拒绝无效 target，关联 S09 诊断；不预执行 factory |

Oxlint 不承担完整包图解析，也不能保证扫描 JSON 清单；清单和安装事实由 doctor/governance 强制执行，CI 与构建不能只依赖编辑器报警。静态不可确定的动态加载由运行接纳补查。检查默认只读，修复通过明确的依赖维护操作完成。

迁移：保留并完善 `workbench-peer.ts` 的 peer 契约；逐一核对 Host、Workbench、publisher 及其基础库的清单和打包 external；提取开发/生产共用的准入判定，收窄 Services 的改道范围。optional peer 只用于真实隔离的可选入口，不用来掩盖无条件 import。不得批量迁移 React、Elysia 或所有核心 peer。

验收：漏声明但恰被提升安装、不兼容版本、私自内联运行时均失败；两个仓库同版本不同安装位置可打开 View；独立 RPC 不被改写；开发、生产和搬离仓库的发行制品结果一致。诊断必须让 agent 分清“改清单”“更新安装”“修打包”与“框架加载接线错误”，不能一律建议重装。

### S05：Shell manifest 应是明确的制品契约，而非入口猜测（P1，已确认）

证据：[shell/assets.ts](../../packages/workbench/src/shell/assets.ts) 的 `pickEntry` 在预期 entry 不存在时取第一个 `isEntry`，甚至第一个 key；读取 manifest 时尝试多个路径并捕获所有异常。[shell/ui-public.ts](../../packages/workbench/src/shell/ui-public.ts) 另按“目录存在”选择默认目录。

重设计：默认包布局只由一个 resolver 决定；自定义 publicDir 保留。制品必须有明确入口及可验证的 imports/css 闭包，缺失或歧义不能按对象顺序选择。已选 manifest 损坏就报告该文件，不尝试另一个可能陈旧的制品。资源 base、导航 base 和公开 origin 的职责保持分离。

补充证据：同文件 `visit()` 遇到缺失 manifest key 直接返回，`visited` 只用于文件去重，递归没有按 manifest key 截止。应按节点去重后遍历：合法循环引用可终止，缺失引用报告引用链；不能机械拒绝所有循环。制品检查覆盖静态 imports、动态 imports、CSS 与引用文件，按 Vite 实际 manifest 格式验证，不要求把懒加载 chunk 全部 preload。

范围：清单检查可证明文件存在与引用完整，不能证明所有浏览器执行都正确；资源 base 和跨 runtime 消费仍由 S10 的真实任务验证。

验收：明确入口存在时允许多入口；入口缺失或选择歧义、坏 JSON、缺 chunk、错误 base 在 build/package 检查时失败；搬离仓库仍能正确读取。不要通过新增根路径 `/assets` alias 掩盖产物错误。

### S06：受控配置的未知字段与非法显式值不能被默认值覆盖（P1，已确认局部缺口）

正面基线：[application.ts](../../packages/host/src/application.ts) 已拒绝未知顶层字段；[environment.ts](../../packages/host/src/environment.ts) 已校验官方变量。
反例：[services/preset.ts](../../packages/services/src/preset.ts) 使用 `options.workbench ?? true`，没有在此边界校验其类型或未知 key；[cli/config.ts](../../packages/cli/src/config.ts) 将显式空白 state-dir 环境变量当作未设置。

重设计：优先校验 JS/JSON/env 等实际输入边界，以及会选择服务、存储或权限策略的有限配置。未知字段报出字段路径；`undefined` 可以使用默认，空字符串、拼错字段、错误布尔值按契约拒绝。不要对所有内部对象递归加验证，更不能替第三方 SDK 拒绝其合法扩展字段。

验收：TS 变量传参绕过 excess-property check、JS 调用、JSON 配置和 env 的非法输入都不能改变成另一个合法默认行为；官方缺省用法保持简单。

## 资源与运行诊断

### S07：资源 IO 失败不能伪装成 404 或 SPA 页面（P2，已确认）

证据：[elysia/assets.ts](../../packages/services/src/elysia/assets.ts) 和 [shell/ui-public.ts](../../packages/workbench/src/shell/ui-public.ts) 将所有 `stat` 异常转换成空值；前者还可能继续 HTML fallback。

重设计：不存在/不是文件按路由契约处理；权限、IO 和内部错误保留到服务端诊断并返回服务器错误。路径越界的统一拒绝是安全边界，应保留，不能为了诊断暴露物理路径给匿名客户端。

验收：不存在文件仍 404；EACCES/EIO 不能变成正常首页；日志可定位部署目录与失败操作，不泄露请求中的密钥。

### S08：可恢复的开发启动与可运行的应用必须明确区分（P2，现场已观察）

证据：[host-vite.ts](../../packages/host-dev/src/host-vite.ts) 初始 `apply()` 失败经 `catch(report)` 后 Vite 与控制台仍可存在；本轮出现 instances 可发现但 run 返回 `dev_unavailable`。这是保留开发恢复能力，不应简单改成杀掉 Vite。

重设计：discovery/控制台暴露尚未接纳、运行中、替换失败仍服务旧实例等真实状态，并关联最近一次接纳诊断。没有 Host 的情况下仍能读取该诊断；普通业务脚本必须明确拒绝执行。生产初次启动没有有效 Host 时应失败退出，另核对现有 launcher 契约后补缺，不能据 Vite 的行为推断生产也有同一缺陷。

验收：语法/依赖错误可直接定位，修正后原 Vite 能恢复；探测“进程存在”不再被当成应用 ready。

### S09：factory 错误需要定位信息，不是更多客户端堆栈（P2，现场已观察）

证据：[WorkbenchRegistry.ts](../../packages/workbench/src/services/workbench/WorkbenchRegistry.ts) 在记录原始异常后返回 `factory_failed`；本次需要经控制台日志才能区分 RpcTarget 身份与业务 factory 异常。

重设计：保留稳定 code 和服务端 cause，附带可关联的诊断标识、目标 node/entry 和失败阶段；授权的开发控制台可定位详情。对已知契约违例给出明确诊断，未知业务异常不靠 message 正则分类。前端不输出凭据、任意 props 或未经处理的堆栈。

验收：错误原型、复用旧 target、超时、owner 撤回与业务抛错可区分；不提前运行 factory，不自动重试可能有副作用的打开操作。

### S10：把兼容性约束落实到产物与真实消费路径（P1，已有现场证据与局部修复）

已有 Workbench 故障修复保留并作为基线，不因提案重新回滚或重复实现。当前工作区是否已包含某项修复，实施前以源码和测试核对。

本轮 Portless origin、Shell 动态资源 base、RpcTarget 原生实例、开发 JSX 与生产 Shell 的组合均说明：版本相同、typecheck 通过、主页可访问不等于 View 可消费。

重设计：在现有构建契约内记录真正影响消费的条件；改变产物语义时自动或明确更新 revision。已提交 manifest 必须对应完整制品；跨目录旧产物不能作为成功备用。优先补既有 build contract，不另创一套通用协商协议。

验收：一条真实浏览器任务覆盖独立安装的 publisher → 官方开发宿主 → 打包 Shell → 打开 View → 读取 RPC → 关闭释放；再覆盖直连/代理与生产发行路径。对每个发现保留最小反例，不能只用源码字符串检查取代端到端验收。

## 明确保留的行为

- 不存在的新状态文件采用初始配置；缺省参数使用文档默认值。
- HMR 拒绝坏候选并保留已运行实例，必须伴随准确失败报告。
- 所有者撤回后的 admission 拒绝、请求取消、幂等清理；不要强制普通关闭变成内部错误。
- 已声明的可选依赖缺失与路由未命中；SPA fallback 只用于合法 HTML 导航。
- `input-bindings.ts` 已有输入校验和不泄露值的错误处理，不能因 `catch` 而误判为兜底。
- 版本、ABI、配置 schema 已经严格的检查继续复用，不复制一套“更严格”实现。

## 迁移顺序与完成条件

会话交接先核对 Git 状态：基线中的 Workbench 修复可能仍是未提交改动，必须与本提案的待实施项分开识别、保留及验证。没有反例证明的审查方向不扩成阻塞全部迁移的新项目；已被当前实现满足的项记录证据后关闭。

1. **数据与事实可信：S01 → S02/S03。** 先阻止损坏文件被覆盖，再消除不完整发现和错误解析；用临时 fixture 验证，禁止破坏真实项目数据。
2. **声明与执行一致：S04/S06。** 先列出 Host、publisher、基础库及安装/构建入口，再迁移主仓与 local-projects；先统一共享规则，后调整调用方。不批量改 vendor；生成发布清单通过生成器更新。
3. **制品可消费：S05/S07/S10。** 校验完整产物，执行真实浏览器路径；列出每个 local-project 的实际入口和结果，不把单个项目成功称作全部覆盖。
4. **S08/S09 随相关批次交付。** 依赖错误必须在未 ready 时即可查看；View 失败必须能关联服务端详情，不能等所有迁移结束才补诊断。

开始 S04 前，核对[已有第三方边界记录](PLUGIN_THIRD_PARTY_VERSION_BOUNDARIES.md)与当前实现：已有生产接线、peer 准入及测试继续复用；本提案只补开发/生产一致性、基础库覆盖和诊断缺口。历史“已验证”不等于当前依赖版本和所有 local-projects 已验证。

每批完成必须具备：

- 一个实际错误输入及其明确诊断，一个正常路径；只在跨模块/运行时行为无法由局部检查证明时增加集成测试。
- 验证声明、实际安装和运行实例是不同事实；S04 至少覆盖同版本多安装与不兼容版本两种场景。
- 已知调用方、模板、exports 和文档同步；搜索并删除冲突规则、旧入口与无条件兜底，不增加绕过开关。
- 当前契约写入所属 `engineering/` 与 `docs/` 页面；本提案删除已落地部分，不成为第二份 API 规范。
- 独立提交记录影响范围、执行检查和未验证边界。文档变更不冒充实现；类型检查通过不冒充浏览器或发行验证。
