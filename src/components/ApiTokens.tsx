import { useCallback, useEffect, useState, type FormEvent } from 'react'
import type { ApiToken } from '../cloud/api'
import { apiBaseUrl } from '../cloud/config'
import type { Cloud } from '../cloud/context'
import { Modal } from './Modal'

const when = (iso: string) => new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' })

/** Personal API tokens, for n8n and other automation tools, and where to point them. */
export function ApiTokensDialog({ cloud, onClose }: { cloud: Cloud; onClose: () => void }) {
  const { api, reportError } = cloud
  const [tokens, setTokens] = useState<ApiToken[]>([])
  const [name, setName] = useState('')
  const [created, setCreated] = useState<{ name: string; token: string } | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const base = apiBaseUrl()

  const load = useCallback(async () => {
    try {
      setTokens(await api.listTokens())
    } catch (e) {
      reportError(e)
    }
  }, [api, reportError])

  useEffect(() => {
    void load()
  }, [load])

  const create = async (e: FormEvent) => {
    e.preventDefault()
    const value = name.trim()
    if (!value) return
    try {
      const { token } = await api.createToken(value)
      setCreated({ name: value, token })
      setName('')
    } catch (err) {
      reportError(err)
    }
    await load()
  }

  const revoke = async (token: ApiToken) => {
    if (!window.confirm(`Revoke “${token.name}”? Anything using it stops working.`)) return
    try {
      await api.revokeToken(token.id)
    } catch (e) {
      reportError(e)
    }
    await load()
  }

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(text)
    } catch {
      window.prompt('Copy this', text)
    }
  }

  const field = (label: string, value: string) => (
    <li>
      <span className="share-who">{label}</span>
      <input
        readOnly
        className="share-link"
        aria-label={label}
        value={value}
        onFocus={(e) => e.currentTarget.select()}
      />
      <button className="button" onClick={() => copy(value)}>
        {copied === value ? 'Copied' : 'Copy'}
      </button>
    </li>
  )

  return (
    <Modal title="API tokens" onClose={onClose} wide>
      <h2>API tokens</h2>
      <p className="muted">
        Let n8n, scripts or AI agents manage your boards. A token acts as you, with your role on each board. Keep it
        secret, and revoke it when you stop using it.
      </p>

      <section className="share-section" aria-label="New token">
        <h3>New token</h3>
        <form className="share-row" onSubmit={create}>
          <input
            className="grow"
            required
            maxLength={100}
            aria-label="Token name"
            placeholder="e.g. n8n"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <button className="button primary" type="submit">
            Create token
          </button>
        </form>
        {created && (
          <div className="token-created" role="status">
            <p>Copy the token for “{created.name}” now. It won’t be shown again.</p>
            <ul className="share-list">{field('Your new token', created.token)}</ul>
          </div>
        )}
      </section>

      <section className="share-section" aria-label="Your tokens">
        <h3>Your tokens</h3>
        {tokens.length === 0 ? (
          <p className="muted small">No tokens yet.</p>
        ) : (
          <ul className="share-list">
            {tokens.map((token) => (
              <li key={token.id}>
                <div className="share-who">
                  <strong>{token.name}</strong>
                  <small className="muted">
                    Created {when(token.createdAt)} ·{' '}
                    {token.lastUsedAt ? `last used ${when(token.lastUsedAt)}` : 'never used'}
                  </small>
                </div>
                <button className="button ghost" aria-label={`Revoke ${token.name}`} onClick={() => revoke(token)}>
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="share-section" aria-label="Connect">
        <h3>Connect</h3>
        <ul className="share-list">
          {field('REST API', `${base}/v1`)}
          {field('MCP server', `${base}/mcp`)}
        </ul>
        <p className="muted small">
          Send the token as <code>Authorization: Bearer &lt;token&gt;</code>. The REST API is described at{' '}
          <a href={`${base}/v1/openapi.json`} target="_blank" rel="noreferrer">
            openapi.json
          </a>
          . In n8n, use an HTTP Request node or the MCP Client tool with Bearer auth.
        </p>
      </section>
    </Modal>
  )
}
