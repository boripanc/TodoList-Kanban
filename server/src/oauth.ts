// OAuth 2.1 authorization server for MCP clients, such as Claude's custom
// connectors (MCP authorization spec): discovery metadata (RFC 9728, RFC 8414),
// dynamic client registration (RFC 7591), the authorization code flow with
// PKCE (S256 only) and rotating refresh tokens. People sign in with their app
// account and allow the client; its access tokens then act as that person with
// the same role checks as the app. API keys stay the way in for n8n.
import { createHash, timingSafeEqual } from 'node:crypto'
import { Hono, type Context } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'
import { cors } from 'hono/cors'
import type { User } from './access.ts'
import { hashToken, newToken, verifyPassword } from './auth.ts'
import type { Db } from './db.ts'
import * as v from './validate.ts'

export const ACCESS_TOKEN_PREFIX = 'kbo_'
const REFRESH_TOKEN_PREFIX = 'kbr_'
const CLIENT_SECRET_PREFIX = 'kbs_'
const ACCESS_TOKEN_SECONDS = 60 * 60
const REFRESH_TOKEN_DAYS = 90
const CODE_SECONDS = 5 * 60
const CSRF_COOKIE = 'kanban_oauth_csrf'
const SCOPE = 'boards'

export interface OAuthOptions {
  db: Db
  secureCookies: boolean
  /** The site's public address (PUBLIC_URL); otherwise taken from the request and proxy headers. */
  publicUrl?: string
  sessionUser: (c: Context) => Promise<User | null>
  startSession: (c: Context, userId: string) => Promise<void>
  signInLimiter: { check(key: string): void; failed(key: string): void; succeeded(key: string): void }
}

/** The address people and clients reach this server at, e.g. https://workstream.example.com. */
export function publicOrigin(c: Context, publicUrl?: string): string {
  if (publicUrl) return publicUrl.replace(/\/+$/, '')
  const url = new URL(c.req.url)
  const proto = c.req.header('x-forwarded-proto')?.split(',')[0].trim() || url.protocol.replace(':', '')
  const host = c.req.header('x-forwarded-host')?.split(',')[0].trim() || c.req.header('host') || url.host
  return `${proto}://${host}`
}

export const protectedResourceMetadataUrl = (origin: string) => `${origin}/.well-known/oauth-protected-resource/api/mcp`
export const rootResourceMetadataUrl = (origin: string) => `${origin}/.well-known/oauth-protected-resource`

/** The user an OAuth access token belongs to, or null when it's unknown or expired. */
export async function userForAccessToken(db: Db, token: string): Promise<User | null> {
  const { rows } = await db.query<User & { client_id: string; last_used_at: Date | null }>(
    `select u.id, u.email, t.client_id, g.last_used_at from kanban.oauth_tokens t
     join kanban.oauth_grants g on g.user_id = t.user_id and g.client_id = t.client_id
     join kanban.users u on u.id = t.user_id
     where t.token_hash = $1 and t.kind = 'access' and t.expires_at > now()`,
    [hashToken(token)],
  )
  const row = rows[0]
  if (!row) return null
  if (!row.last_used_at || Date.now() - new Date(row.last_used_at).getTime() > 60_000) {
    await db.query('update kanban.oauth_grants set last_used_at = now() where user_id = $1 and client_id = $2', [
      row.id,
      row.client_id,
    ])
  }
  return { id: row.id, email: row.email }
}

/** Discovery documents, served at the site root. */
export function wellKnownRoutes({ publicUrl }: Pick<OAuthOptions, 'publicUrl'>) {
  const app = new Hono()
  app.use('/.well-known/*', cors())
  // The MCP server answers at /api/mcp and at the site root, so each has its own metadata.
  const resource = (path: string) => (c: Context) => {
    const origin = publicOrigin(c, publicUrl)
    return c.json({
      resource: `${origin}${path}`,
      authorization_servers: [origin],
      scopes_supported: [SCOPE],
      bearer_methods_supported: ['header'],
      resource_name: 'TodoList Kanban',
    })
  }
  app.get('/.well-known/oauth-protected-resource', resource('/'))
  app.get('/.well-known/oauth-protected-resource/api/mcp', resource('/api/mcp'))
  app.get('/.well-known/oauth-protected-resource/api/mcp/', resource('/api/mcp'))
  const server = (c: Context) => {
    const origin = publicOrigin(c, publicUrl)
    return c.json({
      issuer: origin,
      authorization_endpoint: `${origin}/api/oauth/authorize`,
      token_endpoint: `${origin}/api/oauth/token`,
      registration_endpoint: `${origin}/api/oauth/register`,
      scopes_supported: [SCOPE],
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
      code_challenge_methods_supported: ['S256'],
      authorization_response_iss_parameter_supported: true,
    })
  }
  app.get('/.well-known/oauth-authorization-server', server)
  app.get('/.well-known/openid-configuration', server)
  return app
}

type Client = { id: string; secret_hash: string | null; name: string; redirect_uris: string[] }

const escape = (s: string) =>
  s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!)

const sameSecret = (a: string, b: string) => {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

const s256 = (verifier: string) => createHash('sha256').update(verifier).digest('base64url')

/** The page that asks the person to sign in (if needed) and allow the client. */
function consentPage(opts: {
  client: Client
  redirectHost: string
  user: User | null
  fields: Record<string, string>
  error?: string
}) {
  const hidden = Object.entries(opts.fields)
    .map(([name, value]) => `<input type="hidden" name="${escape(name)}" value="${escape(value)}">`)
    .join('')
  const signIn = opts.user
    ? `<p>Signed in as <strong>${escape(opts.user.email)}</strong>.</p>`
    : `<label>Email<input type="email" name="email" required autocomplete="email" autofocus></label>
       <label>Password<input type="password" name="password" required autocomplete="current-password"></label>`
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Allow access · TodoList Kanban</title>
<style>
  :root { --bg: #f4f5f7; --surface: #fff; --text: #1c2024; --muted: #60646c; --border: #d5d7de; --accent: #0d74ce; --accent-text: #fff; --danger: #ce2c31; color-scheme: light dark; }
  @media (prefers-color-scheme: dark) { :root { --bg: #111113; --surface: #212225; --text: #edeef0; --muted: #a0a2a9; --border: #3a3b40; --accent: #3b9eff; --accent-text: #0b0b0c; --danger: #ff6369; } }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--text); font: 15px/1.5 system-ui, sans-serif; padding: 16px; box-sizing: border-box; }
  form { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 24px; width: 100%; max-width: 380px; display: flex; flex-direction: column; gap: 12px; }
  h1 { font-size: 1.25rem; margin: 0; }
  p { margin: 0; }
  .muted { color: var(--muted); font-size: 0.9rem; }
  .error { color: var(--danger); }
  label { display: flex; flex-direction: column; gap: 4px; font-size: 0.9rem; }
  input[type=email], input[type=password] { font: inherit; padding: 8px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); color: var(--text); }
  .actions { display: flex; gap: 8px; }
  button { font: inherit; padding: 8px 14px; border-radius: 6px; border: 1px solid var(--border); background: transparent; color: var(--text); cursor: pointer; }
  button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-text); }
</style>
</head>
<body>
<form method="post" action="/api/oauth/authorize">
  <p class="muted">▦ TodoList Kanban</p>
  <h1>Allow ${escape(opts.client.name)} to use your boards?</h1>
  <p>It will be able to read and change the boards you can, with your role on each one. You can disconnect it any time from <strong>API keys</strong> in the app's account menu.</p>
  <p class="muted">After this you go back to ${escape(opts.redirectHost)}.</p>
  ${opts.error ? `<p class="error" role="alert">${escape(opts.error)}</p>` : ''}
  ${signIn}
  ${hidden}
  <div class="actions">
    <button class="primary" type="submit" name="decision" value="allow">${opts.user ? 'Allow' : 'Sign in and allow'}</button>
    <button type="submit" name="decision" value="deny" formnovalidate>Cancel</button>
  </div>
</form>
</body>
</html>`
}

function errorPage(message: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Can't connect · TodoList Kanban</title></head>
<body style="font: 15px/1.5 system-ui, sans-serif; padding: 24px; max-width: 480px; margin: auto"><h1 style="font-size: 1.25rem">Can't connect this app</h1><p>${escape(message)}</p></body></html>`
}

/** Registration, sign-in and consent, and tokens, under /api/oauth. */
export function oauthRoutes(opts: OAuthOptions) {
  const { db } = opts
  const app = new Hono()
  app.use('/register', cors())
  app.use('/token', cors())

  const oauthError = (c: Context, error: string, description: string, status: 400 | 401 = 400) => {
    c.header('Cache-Control', 'no-store')
    return c.json({ error, error_description: description }, status)
  }

  // --- Dynamic client registration ---

  app.post('/register', async (c) => {
    let registration: v.OAuthClientRegistration
    try {
      registration = v.oauthClientRegistration(await c.req.json().catch(() => null))
    } catch (error) {
      if (error instanceof v.BadClientMetadata) return oauthError(c, error.code, error.message)
      if (error instanceof v.BadRequest) return oauthError(c, 'invalid_client_metadata', error.message)
      throw error
    }
    const id = newToken()
    const secret = registration.authMethod === 'none' ? null : CLIENT_SECRET_PREFIX + newToken()
    const { rows } = await db.query<{ created_at: Date }>(
      `insert into kanban.oauth_clients (id, secret_hash, name, redirect_uris) values ($1, $2, $3, $4) returning created_at`,
      [id, secret && hashToken(secret), registration.name, JSON.stringify(registration.redirectUris)],
    )
    c.header('Cache-Control', 'no-store')
    return c.json(
      {
        client_id: id,
        client_id_issued_at: Math.floor(new Date(rows[0].created_at).getTime() / 1000),
        ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
        client_name: registration.name,
        redirect_uris: registration.redirectUris,
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: registration.authMethod,
      },
      201,
    )
  })

  // --- Sign-in and consent ---

  async function findClient(id: unknown): Promise<Client | null> {
    if (typeof id !== 'string' || !id || id.length > 200) return null
    const { rows } = await db.query<Client>(
      'select id, secret_hash, name, redirect_uris from kanban.oauth_clients where id = $1',
      [id],
    )
    return rows[0] ?? null
  }

  type AuthRequest =
    | { ok: false; page: string }
    | { ok: false; redirect: string }
    | { ok: true; client: Client; redirectUri: string; fields: Record<string, string> }

  /** Check an authorization request. Problems with the client or redirect URI never redirect. */
  async function checkRequest(c: Context, params: Record<string, unknown>): Promise<AuthRequest> {
    const client = await findClient(params.client_id)
    if (!client) return { ok: false, page: 'This app is not registered here. Try connecting again.' }
    const requested = typeof params.redirect_uri === 'string' ? params.redirect_uri : undefined
    const redirectUri = requested ?? (client.redirect_uris.length === 1 ? client.redirect_uris[0] : undefined)
    if (!redirectUri || !client.redirect_uris.includes(redirectUri))
      return { ok: false, page: 'The app asked to return to an address it did not register.' }
    const state = typeof params.state === 'string' ? params.state : undefined
    const back = (error: string, description: string) => {
      const url = new URL(redirectUri)
      url.searchParams.set('error', error)
      url.searchParams.set('error_description', description)
      if (state !== undefined) url.searchParams.set('state', state)
      url.searchParams.set('iss', publicOrigin(c, opts.publicUrl))
      return { ok: false as const, redirect: url.href }
    }
    if (params.response_type !== 'code') return back('unsupported_response_type', 'Only response_type=code is supported')
    const challenge = params.code_challenge
    if (typeof challenge !== 'string' || !/^[A-Za-z0-9_-]{43,128}$/.test(challenge))
      return back('invalid_request', 'A PKCE code_challenge is required')
    if (params.code_challenge_method !== 'S256') return back('invalid_request', 'code_challenge_method must be S256')
    const fields: Record<string, string> = {
      response_type: 'code',
      client_id: client.id,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      scope: typeof params.scope === 'string' && params.scope ? params.scope.slice(0, 200) : SCOPE,
    }
    if (state !== undefined) fields.state = state.slice(0, 1000)
    return { ok: true, client, redirectUri, fields }
  }

  const csrfCookie = (c: Context) => {
    const token = newToken()
    setCookie(c, CSRF_COOKIE, token, {
      httpOnly: true,
      sameSite: 'Strict',
      secure: opts.secureCookies,
      path: '/api/oauth',
      maxAge: 60 * 60,
    })
    return token
  }

  const render = (c: Context, request: Extract<AuthRequest, { ok: true }>, user: User | null, error?: string) => {
    c.header('Cache-Control', 'no-store')
    c.header('X-Frame-Options', 'DENY')
    c.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'")
    return c.html(
      consentPage({
        client: request.client,
        redirectHost: new URL(request.redirectUri).host,
        user,
        fields: { ...request.fields, csrf: csrfCookie(c) },
        error,
      }),
      error ? 400 : 200,
    )
  }

  app.get('/authorize', async (c) => {
    const request = await checkRequest(c, c.req.query())
    if (!request.ok) return 'page' in request ? c.html(errorPage(request.page), 400) : c.redirect(request.redirect)
    return render(c, request, await opts.sessionUser(c))
  })

  app.post('/authorize', async (c) => {
    const form = (await c.req.parseBody()) as Record<string, unknown>
    const request = await checkRequest(c, form)
    if (!request.ok) return 'page' in request ? c.html(errorPage(request.page), 400) : c.redirect(request.redirect)

    // The form must come from the page this server rendered, not another site.
    const cookie = getCookie(c, CSRF_COOKIE)
    if (!cookie || typeof form.csrf !== 'string' || !sameSecret(cookie, form.csrf))
      return render(c, request, await opts.sessionUser(c), 'Your sign-in page expired. Please try again.')

    const back = new URL(request.redirectUri)
    if (request.fields.state !== undefined) back.searchParams.set('state', request.fields.state)
    back.searchParams.set('iss', publicOrigin(c, opts.publicUrl))
    if (form.decision !== 'allow') {
      back.searchParams.set('error', 'access_denied')
      return c.redirect(back.href)
    }

    let user = await opts.sessionUser(c)
    if (!user) {
      let email: string
      try {
        email = v.email(form.email)
      } catch {
        return render(c, request, null, 'Enter the email you use for TodoList Kanban.')
      }
      try {
        opts.signInLimiter.check(email)
      } catch {
        return render(c, request, null, 'Too many attempts. Try again in a few minutes.')
      }
      const { rows } = await db.query<User & { password_hash: string }>(
        'select id, email, password_hash from kanban.users where lower(email) = $1',
        [email],
      )
      const found = rows[0]
      const password = typeof form.password === 'string' ? form.password : ''
      if (!found || !(await verifyPassword(password, found.password_hash))) {
        opts.signInLimiter.failed(email)
        return render(c, request, null, 'Wrong email or password.')
      }
      opts.signInLimiter.succeeded(email)
      await opts.startSession(c, found.id)
      user = { id: found.id, email: found.email }
    }

    const code = newToken()
    await db.query(
      `insert into kanban.oauth_codes (code_hash, client_id, user_id, redirect_uri, code_challenge, scope, expires_at)
       values ($1, $2, $3, $4, $5, $6, now() + interval '${CODE_SECONDS} seconds')`,
      [hashToken(code), request.client.id, user.id, request.redirectUri, request.fields.code_challenge, request.fields.scope],
    )
    back.searchParams.set('code', code)
    return c.redirect(back.href)
  })

  // --- Tokens ---

  async function issueTokens(c: Context, userId: string, clientId: string, scope: string) {
    const access = ACCESS_TOKEN_PREFIX + newToken()
    const refresh = REFRESH_TOKEN_PREFIX + newToken()
    await db.transaction(async (tx) => {
      await tx.query('delete from kanban.oauth_tokens where user_id = $1 and client_id = $2 and expires_at < now()', [
        userId,
        clientId,
      ])
      await tx.query(
        `insert into kanban.oauth_tokens (token_hash, kind, user_id, client_id, scope, expires_at) values
           ($1, 'access', $3, $4, $5, now() + interval '${ACCESS_TOKEN_SECONDS} seconds'),
           ($2, 'refresh', $3, $4, $5, now() + interval '${REFRESH_TOKEN_DAYS} days')`,
        [hashToken(access), hashToken(refresh), userId, clientId, scope],
      )
    })
    c.header('Cache-Control', 'no-store')
    return c.json({
      access_token: access,
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_SECONDS,
      refresh_token: refresh,
      scope,
    })
  }

  app.post('/token', async (c) => {
    const type = c.req.header('content-type') ?? ''
    const form = (
      type.startsWith('application/json')
        ? await c.req.json().catch(() => ({}))
        : await c.req.parseBody().catch(() => ({}))
    ) as Record<string, unknown>
    const text = (name: string) => (typeof form[name] === 'string' ? (form[name] as string) : undefined)

    // Client authentication: HTTP Basic, or client_id (and client_secret) in the body.
    let clientId = text('client_id')
    let secret = text('client_secret')
    const basic = c.req.header('authorization')?.match(/^Basic\s+(\S+)$/i)?.[1]
    if (basic) {
      const [id, pass] = Buffer.from(basic, 'base64').toString().split(':')
      try {
        clientId = decodeURIComponent(id ?? '')
        secret = decodeURIComponent(pass ?? '')
      } catch {
        return oauthError(c, 'invalid_client', 'Malformed client credentials', 401)
      }
    }
    const client = await findClient(clientId)
    if (!client) return oauthError(c, 'invalid_client', 'Unknown client', 401)
    if (client.secret_hash && (!secret || !sameSecret(hashToken(secret), client.secret_hash)))
      return oauthError(c, 'invalid_client', 'Wrong client secret', 401)

    const grantType = text('grant_type')
    if (grantType === 'authorization_code') {
      const code = text('code')
      const verifier = text('code_verifier')
      if (!code || !verifier) return oauthError(c, 'invalid_request', 'code and code_verifier are required')
      // Codes work once: taking it deletes it.
      const { rows } = await db.query<{
        client_id: string
        user_id: string
        redirect_uri: string
        code_challenge: string
        scope: string
        expired: boolean
      }>(
        `delete from kanban.oauth_codes where code_hash = $1
         returning client_id, user_id, redirect_uri, code_challenge, scope, expires_at < now() as expired`,
        [hashToken(code)],
      )
      const grant = rows[0]
      if (!grant || grant.expired || grant.client_id !== client.id)
        return oauthError(c, 'invalid_grant', 'The code is invalid, used or expired')
      const redirectUri = text('redirect_uri')
      if (redirectUri !== undefined && redirectUri !== grant.redirect_uri)
        return oauthError(c, 'invalid_grant', 'redirect_uri does not match')
      if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || !sameSecret(s256(verifier), grant.code_challenge))
        return oauthError(c, 'invalid_grant', 'code_verifier does not match')
      await db.query(
        `insert into kanban.oauth_grants (user_id, client_id) values ($1, $2) on conflict (user_id, client_id) do nothing`,
        [grant.user_id, client.id],
      )
      return issueTokens(c, grant.user_id, client.id, grant.scope)
    }

    if (grantType === 'refresh_token') {
      const refresh = text('refresh_token')
      if (!refresh) return oauthError(c, 'invalid_request', 'refresh_token is required')
      // Refresh tokens rotate: each one works once.
      const { rows } = await db.query<{ user_id: string; client_id: string; scope: string; expired: boolean }>(
        `delete from kanban.oauth_tokens where token_hash = $1 and kind = 'refresh'
         returning user_id, client_id, scope, expires_at < now() as expired`,
        [hashToken(refresh)],
      )
      const token = rows[0]
      if (!token || token.expired || token.client_id !== client.id)
        return oauthError(c, 'invalid_grant', 'The refresh token is invalid or expired')
      return issueTokens(c, token.user_id, client.id, token.scope)
    }

    return oauthError(c, 'unsupported_grant_type', 'Use authorization_code or refresh_token')
  })

  return app
}

/** Apps the user connected with OAuth, for the app's settings. */
export async function listConnectedApps(db: Db, userId: string) {
  const { rows } = await db.query<{ client_id: string; name: string; created_at: Date; last_used_at: Date | null }>(
    `select g.client_id, c.name, g.created_at, g.last_used_at from kanban.oauth_grants g
     join kanban.oauth_clients c on c.id = g.client_id where g.user_id = $1 order by g.created_at`,
    [userId],
  )
  return rows.map((r) => ({
    id: r.client_id,
    name: r.name,
    connectedAt: new Date(r.created_at).toISOString(),
    lastUsedAt: r.last_used_at && new Date(r.last_used_at).toISOString(),
  }))
}

/** Disconnect an app: its tokens stop working. */
export async function disconnectApp(db: Db, userId: string, clientId: string) {
  await db.query('delete from kanban.oauth_grants where user_id = $1 and client_id = $2', [userId, clientId])
  await db.query('delete from kanban.oauth_codes where user_id = $1 and client_id = $2', [userId, clientId])
}
