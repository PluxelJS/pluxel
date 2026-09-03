# Pluxel Identity Platform 设计

> 状态：架构设计，尚未进入实现。

本文是产品架构研究，不是当前 Pluxel API 或已存在的 workspace application。若进入实现，Identity Platform 应作为产品级
独立仓库维护，通过 `pluxel source` 消费当前 Pluxel checkout；本仓库只保留仍会约束双方集成边界的设计结论。

## 目标

Pluxel Identity Platform 是可自托管的身份与授权中心。它以协议无关的身份核心为权威，通过 OIDC/OAuth 服务主流生态，
并以 GNAP 服务由我们控制的客户端、Agent、设备和高级委托场景。

产品目标不是把认证函数包装成插件，而是让身份能力、认证方式、协议入口和管理界面拥有清晰的所有权、依赖关系与生命周期。

首要使用比例预期为：

- OIDC/OAuth：约 90%，作为默认、稳定、面向第三方的互操作协议；
- GNAP：约 10%，作为实验性、面向受控客户端的高级授权协议。

## 问题与假设

当前需要回答的问题是：怎样在不把协议状态、credential ceremony、授权策略和管理 UI 混成一个生命周期的前提下，构成一个
可自托管、可逐步交付的身份产品。

本提案先采用以下假设；实现前必须用调用方和威胁模型验证：

- 首期只有一个 Identity Authority 和一个安全域，不处理多租户或跨 realm federation；
- OIDC/OAuth 是必须稳定互操作的生产入口，GNAP 只服务能够约束版本与密钥行为的自有客户端；
- 浏览器登录、同意和 credential ceremony 是产品业务界面，不能依赖 Workbench 可用；
- Pluxel 提供 lifecycle、owner-bound capability、Vault、database 和 HTTP application 等基础能力，但不替产品决定身份语义；
- 产品规模、发布与安全响应需要独立仓库、CI 和版本生命周期，不把实现加入本仓库 `projects/` workspace。

## 核心原则

1. **身份核心不从属于任何协议。** OIDC claim、scope、authorization code 和 GNAP continuation 都不能成为核心领域模型。
2. **协议适配器拥有协议状态。** 每种协议独立负责客户端语义、交互状态、令牌表达、重放防护和错误映射。
3. **认证方式只产生认证证据。** Password、Passkey、TOTP 等模块证明“谁以何种强度完成了认证”，不能自行签发协议令牌或决定授权。
4. **授权决策集中。** 策略、同意、授权记录和撤销由 Identity Authority 统一裁决，协议层只负责转换请求与表达结果。
5. **业务面与管理面分离。** 登录、同意和设备交互属于公开业务面；Workbench 只投影管理能力，关闭后不得影响身份服务。
6. **安全降级必须失败关闭。** 认证方式、策略、密钥或持久状态不可用时，不得以较弱路径继续完成授权。
7. **先形成闭合产品，再开放扩展点。** 首期只组合明确需要的能力，不为未知第三方实现提前设计通用 SPI。

## 总体架构

```text
                         Identity Platform
                                 │
                         Identity Authority
          ┌──────────────────────┼──────────────────────┐
          │                      │                      │
   Identity Directory      Authentication        Authorization
  subject / identity      password / passkey     policy / consent
  account / lifecycle       TOTP / recovery       grant / assurance
          │                      │                      │
          └──────────────────────┼──────────────────────┘
                                 │
                    protocol-neutral decision
                                 │
                ┌────────────────┴────────────────┐
                │                                 │
          OIDC/OAuth Adapter                  GNAP Adapter
       stable interoperability          experimental advanced flows
                │                                 │
         third-party clients              controlled clients/agents
```

Identity Authority 是唯一身份与授权权威。OIDC/OAuth 和 GNAP 是并列的协议边界，两者共享身份、认证证据、策略与授权事实，
但不共享各自的协议事务或令牌模型。

## 领域边界

### Identity Directory

负责主体、账号、外部身份关联、账号状态和生命周期。主体是平台内稳定身份，不等同于用户名、邮箱、Passkey、OIDC client
或 GNAP client instance。

Directory 不验证凭据、不解释协议请求，也不签发令牌。

### Authentication

负责认证 ceremony 和 credential 生命周期，并向 Authority 产生认证证据。证据至少表达主体、认证时间、认证方式、认证强度
及其有效边界。

认证方式按独立安全领域划分：

- Password：基础认证与兼容入口；
- Passkey：首选的无密码或强认证方式；
- TOTP：第二因素与 step-up，不作为默认独立身份；
- Recovery Codes：恢复 TOTP 或受限账号恢复，不等同于普通密码。

多种认证方式由 Authority 编排。认证模块之间不直接调用，也不能隐式把失败降级成另一种方式。

### Identity Authority

负责一次身份交互从“需要什么保证”到“是否允许访问”的完整裁决，包括：

- 选择认证要求和 step-up 条件；
- 建立与终止统一登录会话；
- 组合认证证据；
- 请求用户同意；
- 评估策略并形成授权决策；
- 创建、查询和撤销授权事实；
- 发布安全与审计事件。

Authority 输出协议无关的结果：主体、认证证据、获准访问、同意依据和授权引用。它不输出 ID Token、Access Token、
Refresh Token 或 GNAP continuation。

### Authorization

授权域把协议请求映射后的语义访问意图与主体、客户端、认证强度、历史同意和策略放在一起裁决。

OIDC scope 与 GNAP access request 保持各自的协议表达；协议适配器负责把它们映射为可裁决的访问意图，并把结果映射回协议。
平台不通过一个无约束的通用 scope 字符串集合伪装协议中立。

### OIDC/OAuth Adapter

这是默认生产协议，负责 OIDC/OAuth 的完整互操作边界，包括 issuer、client、discovery、授权事务、协议令牌、claims、
key publication、撤销及标准错误。

它消费 Authority 的认证和授权结论，但不能绕过 Authority 自行认可主体或扩大获准访问。

首期只支持现代、安全且广泛使用的流程：Authorization Code、PKCE、短期访问令牌、刷新令牌轮换与服务端撤销。
过时或高风险的隐式流程不进入产品边界。

### GNAP Adapter

GNAP 面向我们能够约束的软件客户端，优先覆盖 Agent、CLI、设备、渐进授权、continuation 和 key-bound access。

GNAP 独立拥有 client instance、交互 continuation、proof 和协议令牌。它是可关闭的实验性能力；不可用或演进时不得影响
OIDC/OAuth、Identity Authority 或用户账号的正常运行。

### Administration 与 Workbench

管理域提供用户、客户端、credential、session、grant、协议密钥状态和审计记录的受权管理视图。

Workbench 是管理域的可选投影，不是身份平台的业务依赖：

- 登录、同意、Passkey ceremony 和 GNAP interaction 使用独立业务界面；
- Workbench 关闭时，所有协议与认证流程继续工作；
- 管理员身份与普通终端用户权限分离；
- 平台必须保留不依赖自身公开登录链路的恢复路径，避免自锁。

## Pluxel 组件关系

组件按单向依赖组织，避免认证方式、Authority 与协议适配器形成环：

```text
Identity Directory
       │
       ├─────────────┬─────────────┐
       ▼             ▼             ▼
    Password       Passkey        MFA
                              (TOTP + Recovery)
       └─────────────┬─────────────┘
                     ▼
            Identity Authority
              │           │
              ▼           ▼
        OIDC/OAuth       GNAP
              │           │
              └─────┬─────┘
                    ▼
             Administration
```

具有独立协议、故障边界或治理需求的组件成为 Plugin；只用于拆分同一所有者内部配置、资源和清理的组成保持为 PluginPart。
认证方式是否提升为独立 Plugin，以真实的独立治理需求决定，而不是以文件或功能数量决定。

协议适配器失败只撤回对应协议。Directory、Authority 或其必需认证能力失败时，依赖它们的协议统一停止服务，不发布半可用状态。

## 身份与客户端模型

以下概念必须保持分离：

| 概念                 | 含义                                   |
| -------------------- | -------------------------------------- |
| Subject              | 平台内稳定的个人或机器主体             |
| Account              | 主体可登录、禁用和恢复的账号状态       |
| Credential           | Password、Passkey、TOTP 等认证材料     |
| Device               | 与主体有关联的已知设备及其信任状态     |
| OIDC Client          | OIDC/OAuth 协议中的依赖方              |
| GNAP Client Instance | 以自身实例与密钥证明参与 GNAP 的客户端 |
| Session              | Authority 认可的交互式登录连续性       |
| Grant                | 某主体或客户端获得的一组可撤销授权事实 |

这些实体可以建立显式关联，但不能合并为一个通用 User、Client 或 Session 记录。

## 信任与安全边界

- 外部请求、浏览器输入、协议 metadata 和客户端声明始终是不可信输入。
- credential、会话、授权码、continuation、令牌和恢复材料具有各自独立的期限、用途与撤销语义。
- 协议令牌只由对应协议适配器发行；认证模块和 Workbench 无发行权。
- 协议密钥归对应 issuer 或协议域所有，不抽象为任意组件可取用的全局签名服务。
- 认证证据不能跨越其所属 Authority generation 或已声明的有效期继续使用。
- 账号禁用、credential 变更和高风险安全事件必须能够撤销相关会话与授权。
- 审计记录只保存作出安全判断所需的事实，不记录原始密码、验证码、令牌或不必要的身份数据。

## 产品范围

### 第一阶段

- 单一 Identity Authority；
- 用户与账号生命周期；
- Password、Passkey、TOTP 与 Recovery Codes；
- 统一登录、step-up、consent、grant 与撤销；
- OIDC Discovery、Authorization Code + PKCE、UserInfo、标准令牌与密钥轮换；
- 用户、OIDC client、credential、session、grant 和审计的 Workbench 管理；
- 独立的管理员恢复入口。

### 第二阶段

- GNAP controlled-client flows；
- Agent、CLI 和设备的 key-bound access；
- 更细的策略与委托模型；
- 确有需求后再增加 machine-to-machine 或 device-oriented OAuth 能力。

### 明确不在首期

- 多租户和跨 realm federation；
- SAML、SCIM 与社交登录集合；
- Dynamic Client Registration；
- 短信验证码和邮件基础设施；
- OAuth Implicit 与 Resource Owner Password 流程；
- 任意脚本修改 claims 或授权结论；
- 未经真实调用方验证的第三方认证 SPI。

## 未决问题

以下决策会改变数据模型或信任边界，不能在实现中用局部 helper 默默决定：

1. Authority、Directory 与各协议适配器的具体 Plugin/PluginPart 切分，是否确实需要独立 replacement 和故障撤回；
2. 浏览器业务界面的部署 origin、CSP、cookie boundary，以及与 Runtime Management plane 的物理隔离方式；
3. protocol-neutral access intent 的最小封闭模型，如何避免退化成无约束字符串或协议字段并集；
4. session、grant、credential 和协议事务的持久化 owner、事务边界、加密材料与级联撤销证据；
5. issuer signing key、Passkey/TOTP secret、recovery material 的 Vault 分区、轮换和灾难恢复流程；
6. 独立管理员恢复入口如何证明操作者、限制操作范围并形成不可绕过的审计链；
7. GNAP 首个真实 Agent/CLI 调用方及其 key-bound proof、continuation 和升级兼容要求。

## 架构成功标准

当以下条件同时成立时，这一架构才算成立：

1. Identity Authority 不引用任何 OIDC 或 GNAP 专属概念；
2. 新协议可以消费既有身份与授权事实，而无需改变 credential 模块；
3. 新认证方式可以产生标准认证证据，而无需理解协议令牌；
4. GNAP 可以整体关闭或失败，而 OIDC/OAuth 继续服务；
5. Workbench 可以整体关闭，而登录、授权和协议端点继续服务；
6. 任一 Plugin replacement 或停止都会撤销其拥有的交互、能力与资源；
7. 账号、credential、协议 client、session 与 grant 的所有权始终可明确追溯。
