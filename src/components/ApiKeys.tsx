import { useCallback, useEffect, useState, type FormEvent } from 'react'
import type { ApiKey } from '../cloud/api'
import { apiBaseUrl } from '../cloud/config'
import type { Cloud } from '../cloud/context'
import { Modal } from './Modal'

const when = (iso: string) => new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' })

/** API keys, for n8n and other automation tools, and where to point them. */
export function ApiKeysDialog({ cloud, onClose }: { cloud: Cloud; onClose: () => void }) {
  const { api, reportError } = cloud
  const [keys, setKeys] = useState<ApiKey[]>([])
  const [name, setName] = useState('')
  const [created, setCreated] = useState<{ name: string; key: string } | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const base = apiBaseUrl()

  const load = useCallback(async () => {
    try {
      setKeys(await api.listApiKeys())
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
      const { key } = await api.createApiKey(value)
      setCreated({ name: value, key })
      setName('')
    } catch (err) {
      reportError(err)
    }
    await load()
  }

  const revoke = async (apiKey: ApiKey) => {
    if (!window.confirm(`Revoke “${apiKey.name}”? Anything using it stops working.`)) return
    try {
      await api.revokeApiKey(apiKey.id)
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
    <Modal title="API keys" onClose={onClose} wide>
      <h2>API keys</h2>
      <p className="muted">
        Let n8n, scripts or AI agents manage your boards. An API key acts as you, with your role on each board. Keep it
        secret, and revoke it when you stop using it.
      </p>

      <section className="share-section" aria-label="New API key">
        <h3>New API key</h3>
        <form className="share-row" onSubmit={create}>
          <input
            className="grow"
            required
            maxLength={100}
            aria-label="Key name"
            placeholder="e.g. n8n"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <button className="button primary" type="submit">
            Create API key
          </button>
        </form>
        {created && (
          <div className="key-created" role="status">
            <p>Copy the API key for “{created.name}” now. It won’t be shown again.</p>
            <ul className="share-list">{field('Your new API key', created.key)}</ul>
          </div>
        )}
      </section>

      <section className="share-section" aria-label="Your API keys">
        <h3>Your API keys</h3>
        {keys.length === 0 ? (
          <p className="muted small">No API keys yet.</p>
        ) : (
          <ul className="share-list">
            {keys.map((apiKey) => (
              <li key={apiKey.id}>
                <div className="share-who">
                  <strong>{apiKey.name}</strong>
                  <small className="muted">
                    Created {when(apiKey.createdAt)} ·{' '}
                    {apiKey.lastUsedAt ? `last used ${when(apiKey.lastUsedAt)}` : 'never used'}
                  </small>
                </div>
                <button className="button ghost" aria-label={`Revoke ${apiKey.name}`} onClick={() => revoke(apiKey)}>
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
          Send the key in an <code>X-API-Key</code> header (or as <code>Authorization: Bearer &lt;key&gt;</code>). The
          REST API is described at{' '}
          <a href={`${base}/v1/openapi.json`} target="_blank" rel="noreferrer">
            openapi.json
          </a>
          . In n8n, use a Header Auth credential with the name <code>X-API-Key</code>, on an HTTP Request node or the
          MCP Client tool.
        </p>
      </section>
    </Modal>
  )
}
