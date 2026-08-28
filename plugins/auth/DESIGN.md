# Management 验证插件设计

## 所有权

`@pluxel/auth` 是普通官方 Plugin，不是 Runtime 特例。Runtime 拥有 Management Plane 的入口闸门、physical peer locality、TLS 事实、Workbench/操作 API 路径以及 provider generation admission；插件通过公开的 `ctx.managementAccess.provide()` 注册一个 generation-owned provider。

插件拥有：

- password、TOTP、OIDC 协议；
- Vault credential records；
- browser session、OIDC pending authorization 和 TOTP enrollment；
- Runtime-owned authentication entry point 下的 server-rendered 页面；
- 供 required consumer 复用的 `authenticate(request)` 方法。

插件不拥有 listener、反向代理策略、Workbench backend 或 Runtime management route。业务 route 是否额外使用 `authenticate()` 由其 owner 明确决定；该复用入口只接受 HTTPS Request，不从可伪造的 hostname 推断物理 locality。

## Setup-required 是正常运行状态

Provider 在 Plugin `init()` 中始终注册。缺少本地账号、TOTP enrollment 或 confidential client secret 时，`status().ready` 为 `false`，但 Plugin generation 仍是 running。这使 Runtime 能保持一个简单状态机：

```text
provider absent / ready:false
  -> remote Management fail closed
  -> physical localhost alone may recover and finish setup

provider ready
  -> Management ingress calls provider authorize for every peer, including localhost
  -> unauthenticated requests enter provider login flow
```

凭据错误或 Vault 不可用不会制造“半启动”的业务能力；provider 明确报告 not ready。Public OIDC 不读取无关的 Vault secret，因此 stale confidential record 不能影响它。

## Lifecycle

注册、session、pending authorization、enrollment、failure limiter 和 OIDC cache 都属于一个 Plugin generation。Runtime owner effects 在 stop、restart、replacement、rollback 和 shutdown 时撤销 provider；插件 cleanup 同时清除全部内存状态。Runtime 在 provider call 和 response body 存活期间持有 owner invocation lease，旧 generation 不能在 replacement 后继续签发有效响应。

Session 与配置 mode 绑定，固定存活 12 小时，最多 2,048 个。它们只保存 digest key 和最小 principal，不保存原始 token 或 OIDC claims。
外部 HTTPS session 使用 root-scoped Secure `__Host-` cookie；loopback HTTP 登录使用不同的 host-only local cookie，Runtime 仅在受信任的
`context.local` 下接受它。凭据替换清空 session；TOTP replay counter 的正常推进不视为凭据轮换，不会踢掉其他已登录 session。

## Vault records

Plugin owner 的 Vault KV 使用两个版本化 key：

- `management-account-v1`：一个显示账号、canonical normalized username、固定参数 scrypt verifier，以及可选 TOTP record；
- `oidc-client-secret-v1`：confidential client secret。

Reader 将 Vault 数据视为 `unknown`，严格检查版本、record type、长度、canonical base64url、固定 scrypt 参数、TOTP secret/counter，以及 username normalization。损坏记录使对应 mode not ready；localhost 保存新凭据可以原子替换。写入后调用 Vault `flush()`，只有持久化成功才交换内存 authority。

## 密码与 TOTP

密码 verifier 使用 Node async scrypt：`N=32768`、`r=8`、`p=1`、32-byte key 和 16-byte random salt。进程内 admission 固定为 4 active + 32 queued，避免攻击者选择成本或建立无界队列。账号比较使用 SHA-256 后的 constant-time compare；即使 username 不匹配也执行真实账号 verifier，避免账号枚举。

本地登录按 normalized username 维护最多 1,024 个 generation-local failure record。5 次失败后拒绝该 identity 5 分钟，成功后清除；过期记录清理且最旧 identity 会被逐出。被限制和普通凭据错误使用同一个 HTTP 响应，不新增公开调优项。

TOTP 是 RFC 6238 HMAC-SHA1、6 位、30 秒周期和 `±1` window。每个 account 持久化 `lastAcceptedCounter`，同 generation 内以单一 mutation chain 串行验证与写入，防止并发重复接受。Enrollment 最多 16 个、10 分钟、每项最多 5 次确认。

## OIDC

只实现 Authorization Code flow：

- discovery endpoint 与所有返回 endpoint 必须为无 credentials/fragment 的 HTTPS URL；
- public 和 confidential client 都使用 PKCE S256；
- state 与 nonce 各 256 bit，pending map 只保存 state digest，最多 128 项、10 分钟；
- state cookie 使用 callback-scoped `__Secure-` cookie；外部 session 使用 root-scoped `__Host-` cookie；
- ID token 校验 issuer、client audience、multi-audience `azp`、nonce、required claims、时间和 JWKS signature；
- principal 是 issuer/sub 的固定 SHA-256 identity，不携带 raw subject 或控制字符；
- optional bearer 只对显式 `bearerAudience` 开放。

Discovery、token 和 JWKS 操作都有 timeout；JSON body 流式读取并限制为 64 KiB。JOSE token/claim/signature failure 归类为 invalid credentials，network/JWKS timeout 归类为 unavailable。Authorization endpoint 已有 query 会保留，插件只覆盖本次 OAuth 参数。

## HTTP 边界

唯一未认证路径由 Runtime mount 在 `/__pluxel/admin-access`。Provider 收到相对 path，并只提供 landing、login、logout、setup、OIDC start/callback。Setup 只接受 Runtime 标记的 physical localhost；远程登录要求 Runtime 标记的 secure transport。

生产 static Node listener 可以直接终止 TLS。`PLUXEL_TLS_CERT` 与 `PLUXEL_TLS_KEY` 必须成对配置，并接受内联 PEM 内容或 PEM 文件路径；
加密 private key 可用可选 `PLUXEL_TLS_PASSPHRASE` 解锁。Runtime 在调用 ready provider 前拒绝不安全的远程 Management 请求。

表单仅接受 `application/x-www-form-urlencoded`，流式 body 上限 16 KiB；mutation 同时要求 same-origin、double-submit CSRF 和安全 `returnTo`。所有页面 escape 动态内容并发送 `no-store`、CSP、frame denial、MIME sniffing denial 和 no-referrer headers。

## 明确不做

- 多 mode fallback、多个 provider aggregation；
- 多账号、RBAC、组织/tenant policy；
- recovery code、email reset、refresh token；
- 在普通 Plugin config 中保存 secret；
- bootstrap token 或第二条 recovery protocol；
- 可调的 session/queue/rate-limit 参数。

这些能力有真实需求时应先证明新的身份、持久化或治理边界；当前实现不为假设场景扩大公共契约。
