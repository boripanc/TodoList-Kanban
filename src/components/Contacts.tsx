import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import type { Contact, ContactInput } from '../cloud/api'
import type { Cloud } from '../cloud/context'
import { Modal } from './Modal'

const emptyContact: ContactInput = {
  name: '',
  company: '',
  jobTitle: '',
  email: '',
  phone: '',
  website: '',
  address: '',
  notes: '',
}

const fieldLabels: { key: Exclude<keyof ContactInput, 'name' | 'notes' | 'address'>; label: string; type: string }[] = [
  { key: 'company', label: 'Company', type: 'text' },
  { key: 'jobTitle', label: 'Job title', type: 'text' },
  { key: 'email', label: 'Email', type: 'email' },
  { key: 'phone', label: 'Phone', type: 'tel' },
  { key: 'website', label: 'Website', type: 'url' },
]

function matches(contact: Contact, query: string) {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return [contact.name, contact.company, contact.jobTitle, contact.email, contact.phone, contact.notes].some((v) =>
    v.toLowerCase().includes(q),
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="vault-field">
      <dt>{label}</dt>
      <dd className="pre">{children}</dd>
    </div>
  )
}

const websiteHref = (url: string) => (/^https?:\/\//i.test(url) ? url : `https://${url}`)

/** The user's own address book: people to call, email or remember, kept in their account. */
export function ContactsDialog({ cloud, onClose }: { cloud: Cloud; onClose: () => void }) {
  const { api, reportError } = cloud
  const [contacts, setContacts] = useState<Contact[] | null>(null)
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<{ id: string | null; draft: ContactInput } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setContacts(await api.listContacts())
    } catch (e) {
      reportError(e)
    }
  }, [api, reportError])

  useEffect(() => {
    void load()
  }, [load])

  const save = async (e: FormEvent) => {
    e.preventDefault()
    if (!editing) return
    try {
      if (editing.id) await api.updateContact(editing.id, editing.draft)
      else await api.createContact(editing.draft)
      setEditing(null)
      setError(null)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the contact.')
    }
  }

  const remove = async (contact: Contact) => {
    if (!window.confirm(`Delete “${contact.name}” from your contacts?`)) return
    try {
      await api.deleteContact(contact.id)
    } catch (e) {
      reportError(e)
    }
    await load()
  }

  if (editing) {
    const set = (key: keyof ContactInput, value: string) =>
      setEditing({ ...editing, draft: { ...editing.draft, [key]: value } })
    return (
      <Modal title={editing.id ? 'Edit contact' : 'New contact'} onClose={() => setEditing(null)} wide>
        <form onSubmit={save}>
          <h2>{editing.id ? 'Edit contact' : 'New contact'}</h2>
          <label className="field">
            <span>Name</span>
            <input
              data-autofocus
              required
              maxLength={200}
              value={editing.draft.name}
              onChange={(e) => set('name', e.target.value)}
            />
          </label>
          <div className="form-grid">
            {fieldLabels.map(({ key, label, type }) => (
              <label key={key} className="field">
                <span>{label}</span>
                <input type={type} value={editing.draft[key]} onChange={(e) => set(key, e.target.value)} />
              </label>
            ))}
          </div>
          <label className="field">
            <span>Address</span>
            <textarea rows={2} value={editing.draft.address} onChange={(e) => set('address', e.target.value)} />
          </label>
          <label className="field">
            <span>Notes</span>
            <textarea rows={3} value={editing.draft.notes} onChange={(e) => set('notes', e.target.value)} />
          </label>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <div className="composer-actions">
            <button className="button primary" type="submit">
              {editing.id ? 'Save contact' : 'Add contact'}
            </button>
            <button className="button ghost" type="button" onClick={() => setEditing(null)}>
              Cancel
            </button>
          </div>
        </form>
      </Modal>
    )
  }

  const shown = (contacts ?? []).filter((c) => matches(c, query))

  return (
    <Modal title="Contacts" onClose={onClose} wide>
      <h2>Contacts</h2>
      <div className="share-row">
        <input
          type="search"
          className="grow"
          aria-label="Search contacts"
          placeholder="Search contacts"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button
          className="button primary"
          onClick={() => {
            setError(null)
            setEditing({ id: null, draft: emptyContact })
          }}
        >
          + Add contact
        </button>
      </div>

      {contacts === null ? (
        <p className="muted small">Loading…</p>
      ) : contacts.length === 0 ? (
        <p className="muted small">No contacts yet. Add the people you work with, suppliers or anyone you call often.</p>
      ) : shown.length === 0 ? (
        <p className="muted small">No contacts match “{query}”.</p>
      ) : (
        <ul className="vault-list" aria-label="Your contacts">
          {shown.map((c) => (
            <li key={c.id} className="vault-item">
              <div className="vault-head">
                <div className="share-who">
                  <strong>{c.name}</strong>
                  {(c.jobTitle || c.company) && (
                    <small className="muted">{[c.jobTitle, c.company].filter(Boolean).join(' · ')}</small>
                  )}
                </div>
                <button
                  className="button ghost"
                  aria-label={`Edit ${c.name}`}
                  onClick={() => {
                    setError(null)
                    const { id, createdAt: _c, updatedAt: _u, ...draft } = c
                    setEditing({ id, draft })
                  }}
                >
                  Edit
                </button>
                <button className="button ghost danger" aria-label={`Delete ${c.name}`} onClick={() => remove(c)}>
                  Delete
                </button>
              </div>
              <dl className="vault-fields">
                {c.email && (
                  <Row label="Email">
                    <a href={`mailto:${c.email}`}>{c.email}</a>
                  </Row>
                )}
                {c.phone && (
                  <Row label="Phone">
                    <a href={`tel:${c.phone.replace(/[^\d+]/g, '')}`}>{c.phone}</a>
                  </Row>
                )}
                {c.website && (
                  <Row label="Website">
                    <a href={websiteHref(c.website)} target="_blank" rel="noreferrer">
                      {c.website}
                    </a>
                  </Row>
                )}
                {c.address && <Row label="Address">{c.address}</Row>}
                {c.notes && <Row label="Notes">{c.notes}</Row>}
              </dl>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  )
}
