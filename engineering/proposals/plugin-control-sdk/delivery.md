# 落地顺序与验收

状态：待实施。本目录只交付设计，没有修改运行时代码或验证新生成路径。既有运行测试证明各自当前边界，不代表描述符生成已经存在。

## 当前基础与接入点

| 所有者            | 已有依据                                                                                                                          | 本次需要增加的部分                                            |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Core identity     | [identity.ts](../../../packages/core/src/plugins/runtime/identity.ts)                                                             | 复用 Address/codec；不新增 agent ID 或 identity variant       |
| Toolchain         | [semantic pass](../../../packages/rolldown/src/rolldown/plugins/pluginSemanticsPlugin.ts)、[应用构建](../../APPLICATION_BUILD.md) | 从 resolved facts 与公开声明生成纯 JS/类型，纳入实际发行清单  |
| Host / Script SDK | [SDK 类型](../../../packages/host/src/agent/sdk-types.ts)、[SDK 实现](../../../packages/host/src/agent/sdk.ts)                    | typed descriptor 目标、配置类型关联、契约检查；复用原领域用例 |
| Vite              | [项目 SDK](../../../packages/host-vite/src/project-sdk.ts)、[HMR](../../HMR.md)                                                   | 同一已接纳 candidate 的控制材料发布及脚本消费更新             |
| Script compiler   | [scripts.ts](../../../packages/rolldown/src/scripts.ts)                                                                           | 允许可证明的纯控制入口，检查实际 bundle 闭包                  |
| 包安装            | [Package Manager](../../../plugins/package-manager/DESIGN.md)                                                                     | 消费所选发行材料，并按真实 catalog 接纳状态提供它             |

生成声明与运行定义的契约版本需要共同的事实入口。实施时检查现有 lowering ABI、package inventory 和 catalog metadata 的承载位置，使它们指向同一生成结果；不要让 Host 再运行一遍类型生成，也不要让 Core 为客户端类型维护平行 registry。

## 第一条完整路径

先选两个来源不同、都导出 Counter 的实际插件，各有简单配置 Schema。从同一生产 semantic pipeline 生成对应控制模块，脚本直接 import 其中一个并完成读取、带版本条件修改、核对采用、重启和日志过滤。

应用打包后搬离工作区，保留控制端生成材料，执行端移除源码与编译器。用真实 CLI 上传脚本，确认只有选中的完整地址受到影响。生成的 import alias 改名后结果相同；源码中不再需要遍历列表匹配 exportName。

配置类型至少覆盖 input/output 不同、默认值、错误字段和 Part 组合。静态检查拒绝错误输入，实际 Host 继续检查运行时数据，生成物不是绕过校验的凭证。

## 后续实施顺序

1. 确定 descriptor 输入、默认/fork 选择和配置类型关系，完成上述构建到真实接收端的路径。实际调用例子决定 API，不要求兼容旧 SDK。
2. 接入 Vite 的已有 semantic/candidate/publication 路径。验证生成文件自身不会触发 Plugin 更新，运行定义与发布材料处于对应版本。
3. 在真实包发行与安装路径交付并消费生成材料，覆盖升级、移除、共享依赖、Vite live 与 Native next-start。
4. 迁移默认教程与已知脚本；完整地址发现作为动态任务保留，删除按短名称猜测已知插件的示例。
5. 再按明确业务接口加入方法类型和材料下载。它们复用同一描述符和发行格式，不扩成第二套插件 RPC 系统。

第一条路径用于尽早检验设计，不能替代后续 HMR 与安装边界。每次实现按实际交付范围更新本目录状态，并将已实现规则移入所属正式文档。

## 必须观察的结果

| 场景                                                 | 验收结果                                                                                |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------- |
| 不同 source entry / package 的同名 export            | 生成模块可以准确选择目标，另一个插件状态与配置不变                                      |
| 物理目录搬移、包内部文件变化、minify/code splitting  | canonical entry 不变时运行地址与描述符地址一致                                          |
| 同名包的冲突物理来源                                 | 原准入边界拒绝冲突，不能因生成材料不同而放行                                            |
| import alias 或控制模块 re-export                    | 地址保持原插件声明身份，不把控制入口识别为新 Plugin                                     |
| 纯实现 HMR                                           | 新 generation 生效，原描述符仍定位同一定义；旧实例不因描述符稳定而继续有效              |
| 配置/公开接口 HMR                                    | 生成材料更新到对应契约；旧描述符诊断失配，不按名字降级                                  |
| paused、坏候选、生成失败、连续更新、Host replacement | 不发布未接纳或串代材料；运行报告与材料状态分别真实可查                                  |
| source/root export 改名                              | 旧目标不存在，新目标按新地址出现；不自动领养旧配置                                      |
| default/fork 与 Part                                 | 默认节点明确，fork 不串配置；Part 仍归 owning node                                      |
| npm 升级                                             | 同一公开定义地址稳定，材料来自已接纳的确切包；契约差异明确                              |
| npm 安装失败、卸载及 Native next-start               | 安装 publication、catalog 与运行状态分别呈现，不提前公布不存在的在线目标                |
| 控制端独立安装与打包                                 | 生成 JS/声明闭包可消费，上传包不含 Plugin/Core 实现，执行端不需要源码                   |
| 身份和契约正确但无操作权限                           | 原授权边界拒绝调用，描述符不产生额外权限                                                |
| 首次使用的 agent                                     | 仅凭生成入口、SDK 声明和公开指南完成目标修改及失败修正，不查内部地址字段或猜 exportName |

类型生成、codec 和内部解析在各自 owner 验证；身份跨构建、模块更新和动态安装的断言必须经过真实编译/加载路径。测试保护目标选择和实际行为，不仅比较生成文件字符串。实施涉及公共包时同步 exports、已知调用方、文档及 `.tegami`。

## 范围与尚待验证的实现选择

本次不改 definition/node identity，不新增手填 ID，不删除 fork，不改配置持久化格式，也不引入安装时自动身份迁移。源码路径或公开 export 的身份变更仍走显式维护。

需要在实现中验证的选择包括：声明闭包如何独立交付；公开契约版本怎样同时进入 runtime metadata 与控制制品；Vite 生成模块的精确失效与防自触发；包公开控制入口如何被上传编译器验证。它们可以改变具体文件与参数设计，但不能通过第二套地址算法、全局名称注册或隐式 fallback 规避。
