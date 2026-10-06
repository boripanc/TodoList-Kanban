import { useCallback, useEffect, useState, type FormEvent } from 'react'
import type { Board, Role } from '../types'
import { inviteLink, roleName, type Member, type SentInvite } from '../cloud/api'
import type { Cloud } from '../cloud/context'
import { Modal } from './Modal'

type InviteRole = Exclude<Role, 'owner'>

export function SignInDialog({ cloud, reason, onClose }: { cloud: Cloud; reason?: string; onClose: () => void }) {
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await cloud.signIn(email.trim())
      setSent(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send the link.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title="Sign in" onClose={onClose}>
      <h2>Sign in</h2>
      {sent ? (
        <p>
          We sent a sign-in link to <strong>{email.trim()}</strong>. Open it on this device to continue.
        </p>
      ) : (
        <form className="stack" onSubmit={submit}>
          <p className="muted">
            {reason ??
              'Sign in to keep boards in your account, use them on any device, and share them with other people.'}{' '}
            Boards you made without signing in stay on this device.
          </p>
          <label className="field">
            <span>Email</span>
            <input
              type="email"
              required
              autoComplete="email"
              data-autofocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
            />
          </label>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <div className="composer-actions">
            <button className="button primary" type="submit" disabled={busy}>
              Email me a sign-in link
            </button>
          </div>
        </form>
      )}
    </Modal>
  )
}

export function InvitesDialog({ cloud, onClose }: { cloud: Cloud; onClose: () => void }) {
  const [busy, setBusy] = useState<string | null>(null)
  const act = async (id: string, run: () => Promise<void>) => {
    setBusy(id)
    try {
      await run()
    } catch (e) {
      cloud.reportError(e)
    } finally {
      setBusy(null)
    }
  }
  return (
    <Modal title="Invitations" onClose={onClose}>
      <h2>Invitations</h2>
      {cloud.invites.length === 0 ? (
        <p className="muted">No invitations right now.</p>
      ) : (
        <ul className="share-list">
          {cloud.invites.map((invite) => (
            <li key={invite.id}>
              <div className="share-who">
                <strong>{invite.boardTitle}</strong>
                <small className="muted">
                  From {invite.invitedBy} · {roleName[invite.role]}
                </small>
              </div>
              <button
                className="button primary"
                disabled={busy === invite.id}
                onClick={() =>
                  act(invite.id, async () => {
                    await cloud.acceptInvite(invite.id)
                    if (cloud.invites.length <= 1) onClose()
                  })
                }
              >
                Accept
              </button>
              <button
                className="button ghost"
                disabled={busy === invite.id}
                onClick={() => act(invite.id, () => cloud.declineInvite(invite.id))}
              >
                Decline
              </button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  )
}

/** Members, email invites and invite links for one board. */
export function ShareDialog({ cloud, board, onClose }: { cloud: Cloud; board: Board; onClose: () => void }) {
  const role = board.cloud?.role
  const isOwner = role === 'owner'
  const [members, setMembers] = useState<Member[]>([])
  const [sent, setSent] = useState<SentInvite[]>([])
  const [email, setEmail] = useState('')
  const [emailRole, setEmailRole] = useState<InviteRole>('editor')
  const [linkRole, setLinkRole] = useState<InviteRole>('viewer')
  const [copied, setCopied] = useState<string | null>(null)
  const { api, reportError, saved } = cloud

  const load = useCallback(async () => {
    if (!role) return
    try {
      // A board just moved to the account may still be uploading.
      await saved()
      const [m, s] = await Promise.all([
        api.listMembers(board.id),
        role === 'owner' ? api.listSentInvites(board.id) : Promise.resolve([]),
      ])
      setMembers(m)
      setSent(s)
    } catch (e) {
      reportError(e)
    }
  }, [api, board.id, role, reportError, saved])

  useEffect(() => {
    void load()
  }, [load])

  const run = async (action: () => Promise<unknown>) => {
    try {
      await action()
    } catch (e) {
      reportError(e)
    }
    await load()
  }

  if (!role) {
    return (
      <Modal title="Share board" onClose={onClose}>
        <h2>Share “{board.title}”</h2>
        <p>
          This board is only on this device. Move it to your account to share it and to open it on your other devices.
        </p>
        <div className="composer-actions">
          <button className="button primary" data-autofocus onClick={() => cloud.moveToAccount(board.id)}>
            Move to my account
          </button>
          <button className="button ghost" onClick={onClose}>
            Cancel
          </button>
        </div>
      </Modal>
    )
  }

  const emailInvites = sent.filter((i) => i.email)
  const links = sent.filter((i) => i.token)

  const copy = async (token: string) => {
    const link = inviteLink(token)
    try {
      await navigator.clipboard.writeText(link)
      setCopied(token)
    } catch {
      window.prompt('Copy this link', link)
    }
  }

  return (
    <Modal title={isOwner ? 'Share board' : 'Members'} onClose={onClose} wide>
      <h2>{isOwner ? `Share “${board.title}”` : `Members of “${board.title}”`}</h2>

      <section className="share-section" aria-label="Members">
        <h3>Members</h3>
        <ul className="share-list">
          {members.map((member) => {
            const you = member.userId === cloud.user?.id
            return (
              <li key={member.userId}>
                <div className="share-who">
                  <span>
                    {member.email}
                    {you && <span className="muted"> (you)</span>}
                  </span>
                </div>
                {isOwner && member.role !== 'owner' ? (
                  <>
                    <select
                      aria-label={`Role for ${member.email}`}
                      value={member.role}
                      onChange={(e) =>
                        run(() => api.setMemberRole(board.id, member.userId, e.target.value as InviteRole))
                      }
                    >
                      <option value="editor">{roleName.editor}</option>
                      <option value="viewer">{roleName.viewer}</option>
                    </select>
                    <button
                      className="button ghost"
                      aria-label={`Remove ${member.email}`}
                      onClick={() => {
                        if (window.confirm(`Remove ${member.email} from this board?`)) {
                          void run(() => api.removeMember(board.id, member.userId))
                        }
                      }}
                    >
                      Remove
                    </button>
                  </>
                ) : (
                  <span className="muted">{roleName[member.role]}</span>
                )}
              </li>
            )
          })}
        </ul>
      </section>

      {isOwner && (
        <>
          <section className="share-section" aria-label="Invite by email">
            <h3>Invite by email</h3>
            <form
              className="share-row"
              onSubmit={(e) => {
                e.preventDefault()
                const value = email.trim()
                if (!value) return
                void run(async () => {
                  await api.inviteByEmail(board.id, value, emailRole)
                  setEmail('')
                })
              }}
            >
              <input
                type="email"
                required
                aria-label="Email to invite"
                placeholder="friend@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              <select
                aria-label="Role for the invite"
                value={emailRole}
                onChange={(e) => setEmailRole(e.target.value as InviteRole)}
              >
                <option value="editor">{roleName.editor}</option>
                <option value="viewer">{roleName.viewer}</option>
              </select>
              <button className="button primary" type="submit">
                Invite
              </button>
            </form>
            <p className="muted small">
              They will see the invitation when they sign in with this email. Send them a link to the app so they know
              to look.
            </p>
            {emailInvites.length > 0 && (
              <ul className="share-list">
                {emailInvites.map((invite) => (
                  <li key={invite.id}>
                    <div className="share-who">
                      <span>{invite.email}</span>
                      <small className="muted">Invited · {roleName[invite.role]}</small>
                    </div>
                    <button className="button ghost" onClick={() => run(() => api.revokeInvite(invite.id))}>
                      Cancel invite
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="share-section" aria-label="Invite link">
            <h3>Invite link</h3>
            <div className="share-row">
              <select
                aria-label="Role for people joining with the link"
                value={linkRole}
                onChange={(e) => setLinkRole(e.target.value as InviteRole)}
              >
                <option value="viewer">{roleName.viewer}</option>
                <option value="editor">{roleName.editor}</option>
              </select>
              <button
                className="button"
                onClick={() =>
                  run(async () => {
                    const token = await api.createInviteLink(board.id, linkRole)
                    await copy(token)
                  })
                }
              >
                Create link
              </button>
            </div>
            <p className="muted small">Anyone with the link can join after signing in, until you turn it off.</p>
            {links.length > 0 && (
              <ul className="share-list">
                {links.map((invite) => (
                  <li key={invite.id}>
                    <input
                      readOnly
                      className="share-link"
                      aria-label={`Invite link, ${roleName[invite.role]}`}
                      value={inviteLink(invite.token!)}
                      onFocus={(e) => e.currentTarget.select()}
                    />
                    <span className="muted">{roleName[invite.role]}</span>
                    <button className="button" onClick={() => copy(invite.token!)}>
                      {copied === invite.token ? 'Copied' : 'Copy'}
                    </button>
                    <button className="button ghost" onClick={() => run(() => api.revokeInvite(invite.id))}>
                      Turn off
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </Modal>
  )
}
