import { useCallback, useEffect, useState, type FormEvent } from 'react'
import type { Credential, CredentialField, CredentialSecrets, VaultKeySource } from '../cloud/api'
import type { Cloud } from '../cloud/context'
import { credentialKinds, kindInfo, type CredentialKind } from '../lib/credentials'
import { Modal } from './Modal'

interface DraftField {
  key: string
  name: string
  value: string
  secret: boolean
  multiline: boolean
  /** Added by the user, so its name and secrecy can be changed. */
  custom: boolean
  placeholder?: string
}

interface Draft {
  id: string | null
  name: string
  kind: CredentialKind
  url: string
  notes: string
  fields: DraftField[]
}

let nextKey = 1
const fieldKey = () => `f${nextKey++}`

/** The kind's fields, filled from `values` (by name), followed by any other fields in `values`. */
function fieldsFor(kind: CredentialKind, values: { name: string; value: string; secret: boolean; multiline: boolean }[]) {
  const byName = new Map(values.map((f) => [f.name.toLowerCase(), f]))
  const fields: DraftField[] = kindInfo[kind].fields.map((t) => {
    const existing = byName.get(t.name.toLowerCase())
    byName.delete(t.name.toLowerCase())
    return {
      key: fieldKey(),
      name: t.name,
      value: existing?.value ?? '',
      secret: !!t.secret,
      multiline: !!t.multiline,
      custom: false,
      placeholder: t.placeholder,
    }
  })
  for (const f of byName.values()) if (f.value) fields.push({ ...f, key: fieldKey(), custom: true })
  return fields
}

const newDraft = (): Draft => ({ id: null, name: '', kind: 'login', url: '', notes: '', fields: fieldsFor('login', []) })

function matches(credential: Credential, query: string) {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return [credential.name, credential.url, kindInfo[credential.kind].label, ...credential.fields.map((f) => f.value ?? '')].some(
    (v) => v.toLowerCase().includes(q),
  )
}

const MASK = '••••••••'

/** A vault for logins, API keys, tokens, OAuth clients, SSH keys and other secrets, encrypted on the server. */
export function CredentialsDialog({ cloud, onClose }: { cloud: Cloud; onClose: () => void }) {
  const { api, reportError } = cloud
  const [credentials, setCredentials] = useState<Credential[] | null>(null)
  const [keySource, setKeySource] = useState<VaultKeySource>('env')
  const [query, setQuery] = useState('')
  const [revealed, setRevealed] = useState<Record<string, CredentialSecrets>>({})
  const [shown, setShown] = useState<Set<string>>(new Set())
  const [copied, setCopied] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const result = await api.listCredentials()
      setCredentials(result.credentials)
      setKeySource(result.keySource)
    } catch (e) {
      reportError(e)
    }
  }, [api, reportError])

  useEffect(() => {
    void load()
  }, [load])

  const secretsOf = async (id: string): Promise<CredentialSecrets> => {
    const cached = revealed[id]
    if (cached) return cached
    const secrets = await api.revealCredential(id)
    setRevealed((r) => ({ ...r, [id]: secrets }))
    return secrets
  }

  const toggleShown = async (credential: Credential) => {
    const next = new Set(shown)
    if (next.has(credential.id)) next.delete(credential.id)
    else {
      try {
        await secretsOf(credential.id)
      } catch (e) {
        reportError(e)
        return
      }
      next.add(credential.id)
    }
    setShown(next)
  }

  const copy = async (credential: Credential, field: CredentialField) => {
    const id = `${credential.id}:${field.name}`
    try {
      const value = field.secret ? (await secretsOf(credential.id)).fields[field.name] ?? '' : field.value ?? ''
      try {
        await navigator.clipboard.writeText(value)
      } catch {
        window.prompt(`Copy ${field.name}`, value)
      }
      setCopied(id)
    } catch (e) {
      reportError(e)
    }
  }

  const edit = async (credential: Credential) => {
    try {
      const secrets = await secretsOf(credential.id)
      const values = credential.fields.map((f) => ({
        ...f,
        value: f.secret ? secrets.fields[f.name] ?? '' : f.value ?? '',
      }))
      setError(null)
      setDraft({
        id: credential.id,
        name: credential.name,
        kind: credential.kind,
        url: credential.url,
        notes: secrets.notes,
        fields: fieldsFor(credential.kind, values),
      })
    } catch (e) {
      reportError(e)
    }
  }

  const save = async (e: FormEvent) => {
    e.preventDefault()
    if (!draft) return
    const input = {
      name: draft.name,
      kind: draft.kind,
      url: draft.url,
      notes: draft.notes,
      // Empty fields are left out; editing shows the kind's fields again.
      fields: draft.fields
        .filter((f) => f.value !== '')
        .map(({ name, value, secret, multiline }) => ({ name: name.trim(), value, secret, multiline })),
    }
    try {
      if (draft.id) await api.updateCredential(draft.id, input)
      else await api.createCredential(input)
      if (draft.id) {
        const id = draft.id
        setRevealed(({ [id]: _old, ...rest }) => rest)
      }
      setDraft(null)
      setError(null)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the credential.')
    }
  }

  const remove = async (credential: Credential) => {
    if (!window.confirm(`Delete “${credential.name}”? Its secrets can’t be recovered.`)) return
    try {
      await api.deleteCredential(credential.id)
    } catch (e) {
      reportError(e)
    }
    await load()
  }

  if (draft) {
    const setField = (key: string, change: Partial<DraftField>) =>
      setDraft({ ...draft, fields: draft.fields.map((f) => (f.key === key ? { ...f, ...change } : f)) })
    const title = draft.id ? 'Edit credential' : 'New credential'
    return (
      <Modal title={title} onClose={() => setDraft(null)} wide>
        <form onSubmit={save}>
          <h2>{title}</h2>
          <div className="form-grid">
            <label className="field">
              <span>Name</span>
              <input
                data-autofocus
                required
                maxLength={200}
                placeholder="e.g. Company VPN"
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </label>
            <label className="field">
              <span>Type</span>
              <select
                value={draft.kind}
                onChange={(e) => {
                  const kind = e.target.value as CredentialKind
                  setDraft({ ...draft, kind, fields: fieldsFor(kind, draft.fields) })
                }}
              >
                {credentialKinds.map((k) => (
                  <option key={k} value={k}>
                    {kindInfo[k].label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="field">
            <span>Website or service URL</span>
            <input
              type="url"
              placeholder="https://"
              value={draft.url}
              onChange={(e) => setDraft({ ...draft, url: e.target.value })}
            />
          </label>

          <fieldset className="field">
            <legend>Fields</legend>
            {draft.fields.map((f) => (
              <div key={f.key} className="vault-field-row">
                {f.custom ? (
                  <div className="vault-field-name">
                    <input
                      required
                      aria-label="Field name"
                      placeholder="Field name"
                      maxLength={100}
                      value={f.name}
                      onChange={(e) => setField(f.key, { name: e.target.value })}
                    />
                    <label className="checkbox">
                      <input
                        type="checkbox"
                        checked={f.secret}
                        onChange={(e) => setField(f.key, { secret: e.target.checked })}
                      />{' '}
                      Secret
                    </label>
                  </div>
                ) : (
                  <span className="vault-field-label">
                    {f.name}
                    {f.secret && <small className="muted"> · secret</small>}
                  </span>
                )}
                {f.multiline ? (
                  <textarea
                    rows={4}
                    className={`mono ${f.secret ? 'masked' : ''}`}
                    aria-label={f.name || 'Field value'}
                    placeholder={f.placeholder}
                    spellCheck={false}
                    value={f.value}
                    onChange={(e) => setField(f.key, { value: e.target.value })}
                  />
                ) : (
                  <input
                    type={f.secret ? 'password' : 'text'}
                    autoComplete={f.secret ? 'new-password' : 'off'}
                    aria-label={f.name || 'Field value'}
                    placeholder={f.placeholder}
                    spellCheck={false}
                    value={f.value}
                    onChange={(e) => setField(f.key, { value: e.target.value })}
                  />
                )}
                <button
                  type="button"
                  className="icon-button danger"
                  aria-label={`Remove field ${f.name}`}
                  onClick={() => setDraft({ ...draft, fields: draft.fields.filter((x) => x.key !== f.key) })}
                >
                  ✕
                </button>
              </div>
            ))}
            <div>
              <button
                type="button"
                className="button"
                onClick={() =>
                  setDraft({
                    ...draft,
                    fields: [
                      ...draft.fields,
                      { key: fieldKey(), name: '', value: '', secret: true, multiline: false, custom: true },
                    ],
                  })
                }
              >
                + Add field
              </button>
            </div>
          </fieldset>

          <label className="field">
            <span>Notes (encrypted)</span>
            <textarea rows={3} value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} />
          </label>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <div className="composer-actions">
            <button className="button primary" type="submit">
              {draft.id ? 'Save credential' : 'Add credential'}
            </button>
            <button className="button ghost" type="button" onClick={() => setDraft(null)}>
              Cancel
            </button>
          </div>
        </form>
      </Modal>
    )
  }

  const visible = (credentials ?? []).filter((c) => matches(c, query))

  return (
    <Modal title="Credentials" onClose={onClose} wide>
      <h2>Credentials</h2>
      <p className="muted small">
        Passwords, API keys, tokens, OAuth clients, SSH keys and certificates, kept in your account. Secret values are
        encrypted on the server and only open here in the app, never through API keys.
        {keySource === 'database' &&
          ' The server has no CREDENTIALS_KEY set, so the encryption key is kept in the same database. Ask whoever runs the server to set one.'}
      </p>
      <div className="share-row">
        <input
          type="search"
          className="grow"
          aria-label="Search credentials"
          placeholder="Search credentials"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button
          className="button primary"
          onClick={() => {
            setError(null)
            setDraft(newDraft())
          }}
        >
          + Add credential
        </button>
      </div>

      {credentials === null ? (
        <p className="muted small">Loading…</p>
      ) : credentials.length === 0 ? (
        <p className="muted small">No credentials yet.</p>
      ) : visible.length === 0 ? (
        <p className="muted small">No credentials match “{query}”.</p>
      ) : (
        <ul className="vault-list" aria-label="Your credentials">
          {visible.map((c) => {
            const open = shown.has(c.id)
            const secrets = revealed[c.id]
            return (
              <li key={c.id} className="vault-item">
                <div className="vault-head">
                  <div className="share-who">
                    <strong>{c.name}</strong>
                    <small className="muted">
                      {kindInfo[c.kind].label}
                      {c.url && (
                        <>
                          {' · '}
                          <a href={c.url} target="_blank" rel="noreferrer">
                            {c.url}
                          </a>
                        </>
                      )}
                    </small>
                  </div>
                  <button className="button ghost" aria-label={`${open ? 'Hide' : 'Show'} secrets of ${c.name}`} onClick={() => toggleShown(c)}>
                    {open ? 'Hide' : 'Show'}
                  </button>
                  <button className="button ghost" aria-label={`Edit ${c.name}`} onClick={() => edit(c)}>
                    Edit
                  </button>
                  <button className="button ghost danger" aria-label={`Delete ${c.name}`} onClick={() => remove(c)}>
                    Delete
                  </button>
                </div>
                <dl className="vault-fields">
                  {c.fields.map((f) => {
                    const value = f.secret ? (open && secrets ? secrets.fields[f.name] ?? '' : MASK) : f.value ?? ''
                    const id = `${c.id}:${f.name}`
                    return (
                      <div key={f.name} className="vault-field">
                        <dt>{f.name}</dt>
                        <dd className={f.multiline || value.includes('\n') ? 'pre mono' : 'mono'}>{value}</dd>
                        <button
                          className="button ghost small"
                          aria-label={`Copy ${f.name} of ${c.name}`}
                          onClick={() => copy(c, f)}
                        >
                          {copied === id ? 'Copied' : 'Copy'}
                        </button>
                      </div>
                    )
                  })}
                  {open && secrets?.notes && (
                    <div className="vault-field">
                      <dt>Notes</dt>
                      <dd className="pre">{secrets.notes}</dd>
                    </div>
                  )}
                </dl>
              </li>
            )
          })}
        </ul>
      )}
    </Modal>
  )
}
