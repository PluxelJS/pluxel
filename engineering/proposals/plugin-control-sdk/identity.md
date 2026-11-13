# 身份设计的目标与边界

本文解释为何以现有身份模型作为控制 SDK 的基础。地址格式、codec、source canonicalization 与冲突检查以 [Plugin Identity](../../PLUGIN_IDENTITY.md) 为唯一规范；本文不定义第二套身份。

## 身份表达的是哪一份定义

definition 由 canonical entry 与唯一 root named export 确定。entry 是包的公开入口，或 source space 下的规范相对路径。文件系统解析用于确认来源、消除路径歧义和验证边界；最终地址不包含开发机的绝对路径或安装目录。

例如，下列定义的导出名都是 Counter，但来源不同：

```text
source:app/plugins/alpha.ts::Counter
source:app/plugins/beta.ts::Counter
package:@acme/counter::Counter
package:@other/counter::Counter
```

短名称适合阅读，完整地址负责区分。源码中的 import binding 让工具链能够证明定义来自哪里，避免作者再填写一份与声明来源脱节的 ID。

同一个 source 文件经不同路径写法访问，需要先得到同一 canonical entry。包内实际实现文件可以迁移，只要公开入口和 export 不变，package identity 就不变。两份磁盘文件并不必然表示两个定义：同名包的不同物理副本若进入同一 catalog，属于需要拒绝的来源冲突。

## 为什么适合现有架构

### HMR 更新实现，保留逻辑目标

编辑方法实现后，Vite 可以产生新的 constructor 和 generation，definition address 仍指向同一个声明。HMR 以该 definition 进行 replacement，配置、策略和日志可以继续关联原节点，不需要从新 constructor 的对象引用恢复持久身份。

definition、node、generation 分别描述实现定义、default/fork 部署以及一次运行。将三者分开，使同一实现的多个节点可以隔离配置与资源，同时由一次定义更新协调替换。稳定地址不会复活旧实例，原生 handle 仍遵守 generation 寿命，见 [HMR](../../HMR.md#definition-replacement)。

### npm 安装位置和版本可以变化

包定义使用 package name、公开 subpath 与 export。pnpm store、安装 revision、版本号和部署路径不进入地址。升级同一个公开定义时，可以在原目标上接纳新实现，不把原配置和状态误分配给一个由安装目录派生的新目标。

当前 Package Manager 使用不可变 revision/slot 和公开 wrapper；共享依赖的实际物理来源也有单独的验证。逻辑地址负责识别定义，安装层负责证明这次加载的包来源和字节，二者都需要正确，见 [Package Manager](../../../plugins/package-manager/DESIGN.md)。

地址规则本身不提供在线加载能力。当前 Vite 可以观察来源并应用更新，Native 来源的新增安装按其 next-start 行为生效。安装发布、catalog 接纳与插件启动是不同结果，生成的控制 SDK 必须尊重这些边界。

### 构建与远程控制保留同一身份

构建可以把多个插件压缩到一个文件，也可以拆成多个 chunk。lowering 保留声明地址，chunk 路径和压缩 class name 不负责寻址。应用搬离工作区后，客户端仍可以提交相同的结构化地址，而无需 import 服务器文件。

控制描述符正好把这份已有地址交给作者：用户选择 import 的对象，SDK 使用对象内的完整地址。它将稳定身份转化为可读的调用，不需要短名称查找，也不增加一套 agent 专用 ID。

## 哪些变化保持身份

| 变化                                                   | 身份结果                          | 控制端应观察什么                           |
| ------------------------------------------------------ | --------------------------------- | ------------------------------------------ |
| 方法实现变化、HMR 创建新 constructor                   | definition/node 地址不变          | 当前 generation、执行与更新报告            |
| 公开接口或配置类型变化                                 | 地址可保持不变                    | 控制契约版本变化，重新取得类型制品         |
| npm 版本、store 路径或部署绝对目录变化                 | 公开 package entry 不变时地址不变 | 实际包来源、安装及制品版本                 |
| 包内部源码文件移动，公开入口不变                       | package 地址不变                  | 编译和接口变化                             |
| source entry 在同一 source space 内改相对路径          | 地址改变                          | 旧定义删除、新定义新增；需要时显式迁移数据 |
| source space、公开 package subpath 或 root export 改名 | 地址改变                          | 身份变更与迁移诊断                         |
| 描述符文件移动或在调用端 import alias                  | 插件地址不变                      | 更新普通模块导入路径即可                   |
| 同一 definition 的 default 与不同 fork                 | definition 相同，node 不同        | 明确的 variant/fork 选择                   |

稳定性建立在逻辑声明入口不变的条件上。需要跨源码布局重构保持身份的插件，可以使用明确的 package export。源码 rename 不应触发运行时按 displayName 或结构相似性认领旧数据。

## 唯一性的范围与取舍

唯一性域是一个 Host application/persistence profile。同一地址出现在两个部署中，是两个连接目标下的对应插件；不要求全球唯一。SDK 的连接绑定和运行 receipt 继续区分部署、Host 与执行实例。

一个 catalog 中同一 package name 只能对应一个实际包来源。版本不进入身份有利于替换升级，也意味着不能仅靠在两个目录安装 v1/v2 就把它们当成两个可独立选择的定义。不同实例需求使用当前 node/fork 模型；它也不提供不同版本实现并存的能力。

同一 constructor 被多个公开入口或 root export 重复暴露会产生身份歧义，当前规则明确拒绝。生成控制描述符可以被普通 JS re-export，因为它只是携带原地址的数据；不能把该 re-export 当成新的 Plugin 声明。

registry、包版本、摘要、安装位置与签名证明来源或内容，displayName 和 label 帮助展示，Address 负责目标定位。控制制品应分别记录这些信息，不能通过改写地址来混合它们的职责。

## 对现有设计的评价

这套模型的优势在于把模块系统本来就提供的来源关系，变成可跨运行时保存和比较的地址，并与进程内 slot、运行 generation 分开。它适合 Pluxel 的源码开发、插件更新和部署控制目标，值得继续使用。

代价也明确：逻辑入口改名会影响身份，包多版本并存受到约束，来源解析必须严格且一致。构建、HMR 和安装若各自推导入口，仍可能出现漂移。因此本次应复用现有 canonicalization，生成描述符与运行定义共享同一份输入，并用真实发布/更新路径验证一致性。

原规范已经详细说明这些规则，当前需要补齐的是这份设计动机以及作者侧的直接引用方式。实现本提案后，默认示例应展示 import 描述符，完整地址只在诊断和动态发现任务中出现。
