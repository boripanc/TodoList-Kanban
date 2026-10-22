/** The kinds of credential the vault offers, each with the fields it starts with. */

export const credentialKinds = [
  'login',
  'api_key',
  'bearer',
  'oauth2',
  'ssh',
  'certificate',
  'database',
  'cloud',
  'totp',
  'other',
] as const

export type CredentialKind = (typeof credentialKinds)[number]

export interface FieldTemplate {
  name: string
  secret?: boolean
  /** Shown as a text area, for keys and certificates. */
  multiline?: boolean
  placeholder?: string
}

export const kindInfo: Record<CredentialKind, { label: string; fields: FieldTemplate[] }> = {
  login: {
    label: 'Username and password',
    fields: [{ name: 'Username' }, { name: 'Password', secret: true }],
  },
  api_key: {
    label: 'API key',
    fields: [{ name: 'Header name', placeholder: 'e.g. X-API-Key' }, { name: 'API key', secret: true }],
  },
  bearer: {
    label: 'Bearer token / JWT',
    fields: [{ name: 'Token', secret: true, multiline: true }],
  },
  oauth2: {
    label: 'OAuth 2.0 client',
    fields: [
      { name: 'Client ID' },
      { name: 'Client secret', secret: true },
      { name: 'Authorization URL' },
      { name: 'Token URL' },
      { name: 'Scopes' },
      { name: 'Redirect URI' },
      { name: 'Access token', secret: true, multiline: true },
      { name: 'Refresh token', secret: true, multiline: true },
    ],
  },
  ssh: {
    label: 'SSH key',
    fields: [
      { name: 'Host' },
      { name: 'Port', placeholder: '22' },
      { name: 'Username' },
      { name: 'Private key', secret: true, multiline: true },
      { name: 'Passphrase', secret: true },
      { name: 'Public key', multiline: true },
    ],
  },
  certificate: {
    label: 'Certificate (TLS / mTLS)',
    fields: [
      { name: 'Certificate', multiline: true },
      { name: 'Private key', secret: true, multiline: true },
      { name: 'Passphrase', secret: true },
      { name: 'CA certificate', multiline: true },
    ],
  },
  database: {
    label: 'Database',
    fields: [
      { name: 'Host' },
      { name: 'Port' },
      { name: 'Database' },
      { name: 'Username' },
      { name: 'Password', secret: true },
      { name: 'Connection string', secret: true },
    ],
  },
  cloud: {
    label: 'Cloud access key',
    fields: [{ name: 'Access key ID' }, { name: 'Secret access key', secret: true }, { name: 'Region' }],
  },
  totp: {
    label: 'Two-factor (TOTP) secret',
    fields: [{ name: 'Account' }, { name: 'Issuer' }, { name: 'Secret key', secret: true }, { name: 'Recovery codes', secret: true, multiline: true }],
  },
  other: {
    label: 'Other',
    fields: [{ name: 'Value', secret: true }],
  },
}
