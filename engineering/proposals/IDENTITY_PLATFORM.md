# Identity Platform 研究

状态：尚未实现的产品架构。若立项，在独立仓库维护，通过 `pluxel source` 消费框架；本页只保留产品假设、集成边界与未决判断，不构成 Pluxel API 或 roadmap。

## 目标与首期假设

自托管身份/授权中心，以 protocol-neutral Authority 为权威。OIDC/OAuth 面向第三方互操作，GNAP 是可关闭的实验性受控客户端协议；原预期使用比例约 90% / 10%，尚未用实际调用方验证。

首期只有一个 Authority/安全域；登录、consent、credential ceremony 是独立业务 UI，Workbench 只投影管理。Pluxel 提供 lifecycle、Vault、Database、HTTP，身份语义与安全响应由产品拥有。不提前设计第三方认证 SPI。

## 所有权

| 领域           | 拥有                                                                  | 不拥有                                      |
| -------------- | --------------------------------------------------------------------- | ------------------------------------------- |
| Directory      | Subject、Account、外部 identity 关联及账号生命周期                    | credential 验证、协议令牌                   |
| Authentication | Password/Passkey/TOTP/Recovery ceremony、材料与认证证据               | token 发行、授权决策                        |
| Authority      | 认证要求/step-up、登录 session、policy/consent、grant/revoke、审计    | OIDC scopes/codes 或 GNAP continuation 模型 |
| OIDC/OAuth     | issuer/client/discovery、授权事务、claims、token/key/replay/error     | 绕过 Authority 认可主体或扩权               |
| GNAP           | client instance、key-bound proof、interaction/continuation 与协议令牌 | 影响 OIDC 或核心可用性                      |
| Administration | 受权的用户/client/credential/session/grant/key 状态与审计操作         | 业务登录权威、协议发行                      |

依赖从 Directory → Authentication/Authority → protocol adapters → Administration。组件是否成为独立 Plugin 取决于治理、replacement 和故障边界；内部拆分用 Part 或普通模块。协议 adapter 失败只撤回对应协议；Authority/Directory 必需能力失败时 dependent 协议停止，不发布半可用状态。

## 语义与信任边界

- Subject、Account、Credential、Device、OIDC Client、GNAP Client Instance、Session、Grant 分开建模，可显式关联，不能合成万能 User/Client/Session。
- Authentication 只产生带主体、时间、方式、强度、有效范围的证据；Authority 组合证据。失败不能隐式降级到较弱认证。
- Protocol adapters 把各自 access request 转为可裁决的访问意图，再将 Authority 结果映射回协议；不以无约束 scope 字符串并集伪装协议中立。
- 外部输入/metadata 不可信。凭据、code、continuation、token、recovery material 各自拥有用途、期限与撤销语义。
- 协议密钥属于 issuer/protocol domain，不提供任意组件可用的全局签名服务；Authentication/Workbench 无 token 发行权。
- 认证证据不能越过 Authority generation/有效期；账号禁用、credential 变化和高风险事件要撤回关联 session/grant。
- 审计只保存判断所需事实，不记录密码、验证码、token 或无关身份数据。
- 管理员与终端用户权限分离；必须有不依赖公开登录链路的受控恢复路径，避免自锁。

## 产品范围

首期：账号生命周期、Password/Passkey/TOTP/Recovery、session/step-up/consent/grant/revoke、OIDC Discovery/Code+PKCE/UserInfo、短期访问令牌、刷新轮换/撤销/密钥轮换、可选 Workbench 管理及独立恢复入口。

后续仅在真实受控 Agent/CLI/device 需求成立后考虑 GNAP、key-bound access、委托、machine-to-machine 或 device flow。
首期不含多租户/federation、SAML/SCIM、社交登录集合、Dynamic Client Registration、短信/邮件基础设施、Implicit/Password grant、任意脚本修改 claims 或第三方认证 SPI。

## 实现前必须决策

1. Plugin/Part 切分是否对应真实独立 replacement/failure，而非功能数量。
2. 业务 origin、CSP/cookie 与 Management plane 的物理隔离。
3. Access intent 的最小封闭模型及真实协议映射。
4. Session/grant/credential/协议事务的持久 owner、transaction 与级联撤销证据。
5. Vault 分区、issuer key/Passkey/TOTP/recovery 的轮换及灾难恢复。
6. 管理员恢复入口的操作者证明、操作范围与审计链。
7. 首个 GNAP 调用方的 proof/continuation/version compatibility。

## 验收

Authority 不引用协议专属状态；增加协议不修改 credential 模块，增加认证方式不理解 token。GNAP 关闭不影响 OIDC，Workbench 关闭不影响业务流程。任何 owner replacement/stop 都撤回其交互、capability 与资源；全部账号、credential、client、session、grant 始终可追溯所有者。必须结合真实调用方和威胁模型验证，架构表不能替代安全与互操作证据。
