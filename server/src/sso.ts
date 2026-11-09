// Sign-in with an OpenID Connect provider (SSO), next to email and password.
// Authorization code flow with PKCE (S256): the browser goes to the provider,
// comes back to /api/auth/sso/callback with a code, and the server swaps it for
// tokens, checks the ID token (signature, issuer, audience, expiry, nonce) and
// signs the person in. The app account is found by the provider's subject, or
// linked or created by verified email on the first SSO sign-in.
import { createPublicKey, createHash, randomBytes, timingSafeEqual, verify, type JsonWebKey } from 'node:crypto'
import { Hono, type Context } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import type { User } from './access.ts'
import type { Db } from './db.ts'
import { publicOrigin } from './oauth.ts'

export interface SsoConfig {
  /** The provider's issuer, e.g. https://sso.example.com. Its discovery document is read from there. */
  issuer: string
  clientId: string
  /** Without it the server signs in as a public client (PKCE only). */
  clientSecret?: string
  /** Shown on the button: "Sign in with <name>". */
  name: string
  /** For tests; defaults to the global fetch. */
  fetch?: typeof fetch
}

/** SSO settings from SSO_ISSUER, SSO_CLIENT_ID, SSO_CLIENT_SECRET and SSO_NAME, or undefined when not set up. */
export function ssoConfigFromEnv(env: Record<string, string | undefined>): SsoConfig | undefined {
  const issuer = env.SSO_ISSUER?.trim().replace(/\/+$/, '')
  const clientId = env.SSO_CLIENT_ID?.trim()
  if (!issuer || !clientId) return undefined
  return { issuer, clientId, clientSecret: env.SSO_CLIENT_SECRET?.trim() || undefined, name: env.SSO_NAME?.trim() || 'SSO' }
}

export const SSO_CALLBACK_PATH = '/api/auth/sso/callback'
const FLOW_COOKIE = 'kanban_sso'
const FLOW_SECONDS = 10 * 60
const CLOCK_SKEW_SECONDS = 120
const CACHE_MS = 60 * 60 * 1000

interface Discovery {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  jwks_uri: string
  userinfo_endpoint?: string
}

interface Flow {
  state: string
  verifier: string
  nonce: string
  returnTo: string
}

export interface SsoOptions {
  db: Db
  config: SsoConfig
  secureCookies: boolean
  publicUrl?: string
  startSession: (c: Context, userId: string) => Promise<void>
}

class SsoError extends Error {}

const b64url = (data: Buffer | string) => Buffer.from(data).toString('base64url')
const random = () => randomBytes(32).toString('base64url')
const same = (a: string, b: string) => {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/** Only a path on this site, so the sign-in can't be used to send people elsewhere. */
export function safeReturnPath(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return '/'
  return value.slice(0, 2000)
}

export function ssoRoutes(opts: SsoOptions) {
  const { db, config } = opts
  const fetchFn = config.fetch ?? fetch
  const app = new Hono()
  let discovery: { at: number; doc: Discovery } | undefined
  let jwks: { at: number; keys: (JsonWebKey & { kid?: string; use?: string })[] } | undefined

  async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
    let res: Response
    try {
      res = await fetchFn(url, { ...init, signal: AbortSignal.timeout(10_000) })
    } catch {
      throw new SsoError(`Could not reach the sign-in service (${new URL(url).host}).`)
    }
    const data = (await res.json().catch(() => null)) as (T & { error?: string; error_description?: string }) | null
    if (!res.ok || !data || typeof data !== 'object') {
      const reason = data?.error_description ?? data?.error ?? `answered ${res.status}`
      throw new SsoError(`The sign-in service refused: ${reason}`)
    }
    return data
  }

  async function provider(): Promise<Discovery> {
    if (discovery && Date.now() - discovery.at < CACHE_MS) return discovery.doc
    const doc = await getJson<Discovery>(`${config.issuer}/.well-known/openid-configuration`)
    if (doc.issuer !== config.issuer) throw new SsoError('The sign-in service names a different issuer than SSO_ISSUER.')
    for (const key of ['authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const) {
      if (typeof doc[key] !== 'string' || !/^https?:\/\//.test(doc[key]))
        throw new SsoError(`The sign-in service's discovery document has no ${key}.`)
    }
    discovery = { at: Date.now(), doc }
    return doc
  }

  async function signingKey(doc: Discovery, kid: string | undefined, kty: string) {
    const find = () => jwks?.keys.find((k) => (kid ? k.kid === kid : k.kty === kty) && k.use !== 'enc')
    if (!jwks || Date.now() - jwks.at > CACHE_MS || !find()) {
      const set = await getJson<{ keys?: unknown }>(doc.jwks_uri)
      jwks = { at: Date.now(), keys: Array.isArray(set.keys) ? set.keys : [] }
    }
    const jwk = find()
    if (!jwk) throw new SsoError('The sign-in service signed with a key it does not publish.')
    return createPublicKey({ key: jwk, format: 'jwk' })
  }

  /** Checks the ID token and returns its claims. */
  async function verifyIdToken(doc: Discovery, idToken: string, nonce: string): Promise<Record<string, unknown>> {
    const parts = idToken.split('.')
    if (parts.length !== 3) throw new SsoError('The sign-in service sent an unreadable ID token.')
    let header: { alg?: string; kid?: string }
    let claims: Record<string, unknown>
    try {
      header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'))
      claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    } catch {
      throw new SsoError('The sign-in service sent an unreadable ID token.')
    }
    const signed = Buffer.from(`${parts[0]}.${parts[1]}`)
    const signature = Buffer.from(parts[2], 'base64url')
    let ok: boolean
    if (header.alg === 'RS256') {
      ok = verify('sha256', signed, await signingKey(doc, header.kid, 'RSA'), signature)
    } else if (header.alg === 'ES256') {
      ok = verify('sha256', signed, { key: await signingKey(doc, header.kid, 'EC'), dsaEncoding: 'ieee-p1363' }, signature)
    } else {
      throw new SsoError(`The ID token uses an algorithm this app does not accept (${String(header.alg)}).`)
    }
    if (!ok) throw new SsoError('The ID token signature is not valid.')

    const now = Math.floor(Date.now() / 1000)
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
    if (claims.iss !== config.issuer) throw new SsoError('The ID token comes from another issuer.')
    if (!aud.includes(config.clientId)) throw new SsoError('The ID token is for another app.')
    if (aud.length > 1 && claims.azp !== config.clientId) throw new SsoError('The ID token is for another app.')
    if (typeof claims.exp !== 'number' || claims.exp < now - CLOCK_SKEW_SECONDS) throw new SsoError('The ID token has expired.')
    if (typeof claims.iat === 'number' && claims.iat > now + CLOCK_SKEW_SECONDS) throw new SsoError('The ID token is not valid yet.')
    if (typeof claims.nonce !== 'string' || !same(claims.nonce, nonce)) throw new SsoError('The ID token does not match this sign-in.')
    if (typeof claims.sub !== 'string' || !claims.sub) throw new SsoError('The ID token names no user.')
    return claims
  }

  /** The app account for this SSO account: by subject, else by verified email (linking it), else a new one. */
  async function accountFor(subject: string, email: string): Promise<User> {
    return db.transaction(async (tx) => {
      const linked = await tx.query<User>(
        `select u.id, u.email from kanban.user_identities i join kanban.users u on u.id = i.user_id
         where i.issuer = $1 and i.subject = $2`,
        [config.issuer, subject],
      )
      if (linked.rows[0]) {
        await tx.query(
          'update kanban.user_identities set last_sign_in_at = now(), email = $3 where issuer = $1 and subject = $2',
          [config.issuer, subject, email],
        )
        return linked.rows[0]
      }
      let user = (await tx.query<User>('select id, email from kanban.users where lower(email) = $1', [email])).rows[0]
      if (!user) {
        user = (
          await tx.query<User>(
            `insert into kanban.users (email, password_hash) values ($1, null)
             on conflict ((lower(email))) do update set email = kanban.users.email returning id, email`,
            [email],
          )
        ).rows[0]
        console.log('SSO sign-in: created a new account')
      } else {
        console.log('SSO sign-in: linked an existing account by verified email')
      }
      await tx.query(
        `insert into kanban.user_identities (issuer, subject, user_id, email) values ($1, $2, $3, $4)
         on conflict (issuer, subject) do nothing`,
        [config.issuer, subject, user.id, email],
      )
      return user
    })
  }

  const back = (c: Context, message: string) => {
    console.log(`SSO sign-in failed: ${message}`)
    return c.redirect(`/?sso_error=${encodeURIComponent(message)}`)
  }

  app.get('/', (c) => c.json({ sso: { name: config.name } }))

  app.get('/start', async (c) => {
    let doc: Discovery
    try {
      doc = await provider()
    } catch (error) {
      return back(c, error instanceof SsoError ? error.message : 'Could not start SSO sign-in.')
    }
    const flow: Flow = { state: random(), verifier: random(), nonce: random(), returnTo: safeReturnPath(c.req.query('return')) }
    setCookie(c, FLOW_COOKIE, b64url(JSON.stringify(flow)), {
      httpOnly: true,
      // Lax: the provider sends the browser back here with a top-level GET, which carries it.
      sameSite: 'Lax',
      secure: opts.secureCookies,
      path: '/api/auth/sso',
      maxAge: FLOW_SECONDS,
    })
    const url = new URL(doc.authorization_endpoint)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('client_id', config.clientId)
    url.searchParams.set('redirect_uri', publicOrigin(c, opts.publicUrl) + SSO_CALLBACK_PATH)
    url.searchParams.set('scope', 'openid email profile')
    url.searchParams.set('state', flow.state)
    url.searchParams.set('nonce', flow.nonce)
    url.searchParams.set('code_challenge', b64url(createHash('sha256').update(flow.verifier).digest()))
    url.searchParams.set('code_challenge_method', 'S256')
    c.header('Cache-Control', 'no-store')
    return c.redirect(url.href)
  })

  app.get('/callback', async (c) => {
    c.header('Cache-Control', 'no-store')
    const raw = getCookie(c, FLOW_COOKIE)
    deleteCookie(c, FLOW_COOKIE, { path: '/api/auth/sso' })
    let flow: Flow | undefined
    try {
      flow = raw ? (JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Flow) : undefined
    } catch {
      flow = undefined
    }
    const q = c.req.query()
    if (!flow || typeof flow.state !== 'string' || typeof q.state !== 'string' || !same(q.state, flow.state))
      return back(c, 'Your SSO sign-in expired or was started in another tab. Please try again.')
    if (q.iss !== undefined && q.iss !== config.issuer) return back(c, 'The answer came from another sign-in service.')
    if (q.error) return back(c, q.error === 'access_denied' ? 'SSO sign-in was cancelled.' : `SSO sign-in failed: ${q.error_description ?? q.error}`)
    if (!q.code) return back(c, 'The sign-in service sent no code.')

    try {
      const doc = await provider()
      const form = new URLSearchParams({
        grant_type: 'authorization_code',
        code: q.code,
        redirect_uri: publicOrigin(c, opts.publicUrl) + SSO_CALLBACK_PATH,
        code_verifier: flow.verifier,
      })
      const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }
      if (config.clientSecret) {
        const id = encodeURIComponent(config.clientId)
        headers.authorization = `Basic ${Buffer.from(`${id}:${encodeURIComponent(config.clientSecret)}`).toString('base64')}`
      } else {
        form.set('client_id', config.clientId)
      }
      const tokens = await getJson<{ id_token?: string; access_token?: string }>(doc.token_endpoint, {
        method: 'POST',
        headers,
        body: form.toString(),
      })
      if (typeof tokens.id_token !== 'string') throw new SsoError('The sign-in service sent no ID token.')
      const claims = await verifyIdToken(doc, tokens.id_token, flow.nonce)

      // Many providers put email only in userinfo when an access token comes along.
      let email = claims.email
      let verified = claims.email_verified
      if (typeof email !== 'string' && doc.userinfo_endpoint && typeof tokens.access_token === 'string') {
        const info = await getJson<Record<string, unknown>>(doc.userinfo_endpoint, {
          headers: { authorization: `Bearer ${tokens.access_token}`, accept: 'application/json' },
        })
        if (info.sub !== claims.sub) throw new SsoError('The sign-in service returned another user.')
        email = info.email
        verified = info.email_verified
      }
      if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) || email.length > 320)
        throw new SsoError('Your SSO account has no email address. Ask your SSO admin to share it with this app.')
      if (verified !== true && verified !== 'true')
        throw new SsoError('Your SSO account email is not verified yet. Verify it with your SSO provider, then try again.')

      const user = await accountFor(claims.sub as string, email.trim().toLowerCase())
      await opts.startSession(c, user.id)
      console.log('SSO sign-in: signed in')
      return c.redirect(flow.returnTo)
    } catch (error) {
      if (error instanceof SsoError) return back(c, error.message)
      console.error(error)
      return back(c, 'Something went wrong on the server during SSO sign-in.')
    }
  })

  return app
}
