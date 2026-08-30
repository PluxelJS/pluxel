# `@pluxel/auth`

Pluxel 官方 Management authentication provider。它在 Workbench 唯一的 Cap’n Web control socket 上提供密码、密码加 TOTP 或 OIDC 身份验证。

```ts
import { AuthPlugin } from '@pluxel/auth'

host.add(AuthPlugin)
host.cfg(AuthPlugin).set({ mode: { type: 'password' } })
host.start(AuthPlugin)
```

Host 必须安装 Management Plane。`password`、`password-totp` 与 confidential OIDC 使用 Vault；public OIDC 不保存 client secret，因此可以不安装 Vault。当前进程仍只允许一个 active Management authentication provider。

## Control socket flow

- WebSocket upgrade 不等于认证成功。Runtime 在同一 socket 上打开 provider session。
- 密码模式先返回 `password` challenge；密码加 TOTP 在密码通过后返回 `totp` challenge。提交 payload 固定为 `{ password: string }` 和 `{ code: string }`。
- 成功 step 立即授予当前 socket principal，并携带 60 秒、single-use、commit-only ticket。浏览器把 ticket POST 到 Runtime 固定 cookie-commit endpoint，插件只返回 `204 + Set-Cookie`；ticket 不能访问 Management data。
- 已有同源 `HttpOnly` session cookie 时，新 socket 可以直接完成 bootstrap。
- control root logout 会先撤销 server session，再返回同一个固定 cookie-commit endpoint 可消费的 single-use clear ticket，随后关闭整个 socket epoch；不存在 HTTP logout route。
- session、pending commit、challenge、failure limiter 和 OIDC pending state 都有固定上界，并随 Plugin generation 一起撤销。

Password/TOTP challenge、session bootstrap 和 logout 都属于 control object graph。业务路由认证、Bearer token 和 RBAC 由业务 Plugin 单独设计。

## OIDC

```ts
host.cfg(AuthPlugin).set({
	mode: {
		type: 'oidc',
		issuer: 'https://id.example.com',
		clientId: 'pluxel-admin',
		publicOrigin: 'https://admin.example.com',
		clientKind: 'public',
		scopes: ['openid', 'profile', 'email'],
		requiredClaims: { groups: 'pluxel-admins' },
	},
})
```

OIDC challenge 只返回固定 same-origin navigation path。普通 HTTP 只保留 authorization redirect 与 callback；callback 验证 Authorization Code + PKCE、state、nonce、issuer/audience/`azp`、required claims 和 JWKS signature，然后提交 `HttpOnly` cookie 并导航回新 document。Access/refresh token、raw claims 和 subject 不会进入浏览器 session。

Callback 固定为：

```text
<publicOrigin>/__pluxel/admin-access/oidc/callback
```

## Credential readiness 与 setup View

Public OIDC 只依赖配置。Password、password + TOTP 与 confidential OIDC 还要求 Vault 中已有有效 credential record；缺失或
损坏时 provider 返回 `ready: false` / `access_unavailable`。

Workbench enabled 时，插件发布 browser-safe `@pluxel/auth/workbench` 中的 `AuthWorkbench.setup` Direct View，固定 route
`/auth/setup`。它提供 `AuthSetupApi.snapshot()`、`setupPassword()`、`beginTotp()`、`confirmTotp()` 和
`setupOidcSecret()`。Snapshot 是封闭的 `configured | setup-required | unavailable` 联合；mutation 返回带稳定 code 的
`AuthSetupMutationResult` / `AuthTotpEnrollmentResult`。

Mutation 只允许真实 loopback recovery principal，并且只在 credential `missing` / `invalid` 时执行；不能覆盖已配置记录，
public OIDC 不接受 secret。成功保存后 provider 在同一 generation 立即 ready，并撤销旧 cookie session。每次打开创建 fresh target
与 provisioning session；close、abort、epoch invalidation 或 Plugin stop 会清除未完成的 TOTP enrollment。

这是唯一交互式 provisioning 入口；没有 HTTP setup route、CLI 或 transport fallback。`workbench: false` / headless distribution
必须预置相同 Vault credential，或先用带 Workbench artifact 且共享 persistence 的部署完成配置。Public OIDC 无 provisioning，
可以仅凭配置在 headless 中 ready。

## 边界

- 三种 mode 互斥；不聚合多个 provider。
- 本地模式只有一个管理账号，不提供 RBAC、recovery code 或邮件重置。
- OIDC 不实现 refresh token 或身份提供商 logout；control logout 只撤销 Pluxel 自己的 session。
- 远端 control socket 与 OIDC 必须由可信 physical carrier 提供 HTTPS；插件不相信 hostname 或 forwarding headers。
