---
title: Management 认证
description: 用官方 Auth Plugin 在唯一 Cap’n Web control socket 上提供 OIDC、密码或密码加 TOTP。
---

`@pluxel/auth` 是官方 Management authentication provider。它保护 Workbench 与 Management Cap’n Web object graph，不会自动保护业务 Plugin 路由。

## 启用

宿主先启用 Management/Workbench。Password、password + TOTP 与 confidential OIDC 还需要 Vault：

```ts no-twoslash
configure: () => ({
	vault: {},
	workbench: { enabled: true },
})
```

然后加入并启动 `AuthPlugin`：

```ts no-twoslash
host.add(AuthPlugin)
host.cfg(AuthPlugin).set({ mode: { type: 'password' } })
host.start(AuthPlugin)
```

## 浏览器如何认证

Workbench 每个 document 只建立一个 control WebSocket。没有有效 `HttpOnly` cookie 时，password 与 TOTP challenge 直接在该 socket 上完成：

```text
password      { password }
    ↓
totp（按 mode）{ code }
    ↓
authenticated + single-use cookie commit ticket
```

当前 socket 在 authenticated step 后立即取得 principal authority。浏览器随后用 60 秒、single-use ticket 调用固定 cookie-commit endpoint；响应只有 `204 + Set-Cookie`，cookie 用于下一 document/session。Authentication challenge 和 Management API 始终留在同一 Cap’n Web session。

logout 也是 control capability：插件先撤销当前或刚签发的 server session，再返回 60 秒、single-use clear-cookie ticket，Runtime 随后关闭整个 socket epoch。浏览器使用同一个固定 cookie-commit endpoint 清理 `HttpOnly` cookie；server session 一旦撤销，遗留 cookie 也不能恢复它。

## OIDC

```ts no-twoslash
{
	mode: {
		type: 'oidc',
		issuer: 'https://id.example.com',
		clientId: 'pluxel-admin',
		publicOrigin: 'https://pluxel.example.com',
		clientKind: 'public',
	}
}
```

OIDC challenge 返回固定 same-origin navigation path。Authorization redirect 和 callback 是保留的浏览器 HTTP 硬边界；callback 固定为：

```text
<publicOrigin>/__pluxel/admin-access/oidc/callback
```

插件验证 Authorization Code + PKCE、state、nonce、issuer/audience/`azp`、required claims 和 JWKS signature。成功 callback 只提交 `HttpOnly` cookie 并回到新 document；不保存 access/refresh token，也不把 bearer token、raw claims 或 principal 放入 URL/browser storage。

## Credential readiness 与首次配置

Public OIDC 只依赖配置，始终进入 `configured`。Password、password + TOTP 和 confidential OIDC 还要求 Vault 中存在有效
credential record；缺失或损坏时 provider 报告 `ready: false`，远端得到 `access_unavailable`。

Workbench enabled 时，Auth Plugin 发布 `@pluxel/auth/workbench` 的 `AuthWorkbench.setup` Direct View，固定 route 为
`/auth/setup`。这是唯一的交互式 credential provisioning 入口；不存在 setup HTTP endpoint、CLI 命令或备用 transport。通过 SSH
tunnel 打开 loopback Workbench 后进入该 route。View API 是：

```ts no-twoslash
interface AuthSetupApi extends RpcTarget {
	snapshot(): AuthSetupSnapshot
	setupPassword(input: AuthPasswordSetupInput): Promise<AuthSetupMutationResult>
	beginTotp(input: AuthPasswordSetupInput): Promise<AuthTotpEnrollmentResult>
	confirmTotp(input: AuthTotpConfirmationInput): Promise<AuthSetupMutationResult>
	setupOidcSecret(input: AuthOidcSecretSetupInput): Promise<AuthSetupMutationResult>
}
```

`snapshot()` 只返回以下封闭状态：

| mode                 | state            | reason                | 含义                                 |
| -------------------- | ---------------- | --------------------- | ------------------------------------ |
| `oidc-public`        | `configured`     | —                     | 不需要也不接受 client secret         |
| 其余 credential mode | `configured`     | —                     | 已有有效记录，mutation 不允许覆盖    |
| 其余 credential mode | `setup-required` | `missing` / `invalid` | loopback recovery 可以执行一次性配置 |
| 其余 credential mode | `unavailable`    | `vault-unavailable`   | Vault 不可用，mutation fail closed   |

Password 与 TOTP enrollment 共用 `{ username, password, passwordConfirmation }`。`beginTotp()` 返回 enrollment ID、secret、
provisioning URI 和过期时间，只有同一个 opened target 能用 `{ enrollmentId, code }` 确认。Confidential OIDC 只接受
`{ secret }`。失败返回稳定 code：`forbidden`、`not_required`、`unavailable`、`invalid_input`、`busy`、
`enrollment_expired`、`verification_failed` 或 `storage_failed`。

所有 mutation 同时要求真实 loopback recovery principal 和当前 `setup-required` 状态；即使已认证的远端管理员也不能调用，
已配置 credential 不能通过这个 API 覆盖。成功保存后同一 Plugin generation 立即变为 ready，并撤销旧 cookie session。每次打开
View 都得到 fresh target 和 provisioning session；close、abort、socket epoch 失效或 Plugin stop 会销毁未完成的 TOTP enrollment。

`workbench: false` 和 production `headless` artifact 没有 setup View/API。它们使用 local credential 或 confidential OIDC 时必须预置
同一 Vault record，或先用带 Workbench artifact、指向同一 persistence 的部署完成配置再切 headless；否则 provider 保持
`ready: false`。Public OIDC 无 provisioning，可以仅凭配置用于 headless。

## 安全与生命周期

- 远端 control socket 与 OIDC 要求可信 physical carrier 提供 HTTPS；Runtime 不相信 forwarding headers 或 URL hostname。
- password scrypt、登录失败、challenge、session、cookie commit、OIDC pending state 和 TOTP replay counter 都有固定上界。
- stop、replacement 或 credential mutation 会撤销对应 generation 的 authority。
- 业务 HTTP authorization、Bearer token 与 RBAC 由业务 Plugin 自己设计，不属于此 provider。
