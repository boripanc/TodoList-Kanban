import type { CapacitorConfig } from '@capacitor/cli'

/**
 * The iPhone app is a native shell around the live site. Loading the site itself
 * (rather than a bundled copy) keeps the app on the server's own address, so the
 * session cookie and live updates work exactly as in Safari, and every deploy
 * reaches the app without a new App Store release.
 *
 * Set CAP_SERVER_URL to try the app against another server, e.g. a dev machine.
 */
const serverUrl = process.env.CAP_SERVER_URL ?? 'https://workstream.teddybiere.info'

const config: CapacitorConfig = {
  appId: 'info.teddybiere.workstream',
  appName: 'Workstream',
  // Shown only when the site can't be reached (see errorPath).
  webDir: 'ios-shell',
  server: {
    url: serverUrl,
    errorPath: 'offline.html',
    cleartext: serverUrl.startsWith('http://'),
  },
  ios: {
    // The page pads itself for the notch and home bar (env(safe-area-inset-*) in index.css).
    contentInset: 'never',
    backgroundColor: '#f4f5f7',
  },
}

export default config
