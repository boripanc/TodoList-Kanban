# iPhone app

The iPhone app is built with [Capacitor](https://capacitorjs.com). It is a native app shell that opens the live site, `https://workstream.teddybiere.info`, full screen with its own icon. Because it loads the site itself, sign-in, shared boards and live updates work exactly as in Safari, and every deploy of the site reaches the app at once, with no new App Store release. Only changes to the shell (icon, name, native plugins) need a new build.

When the phone is offline, the app shows a "Can't reach your boards" page with a **Try again** button.

What lives where:

| Path | What it is |
| --- | --- |
| `capacitor.config.ts` | App name, bundle ID (`info.teddybiere.workstream`) and the site address the app opens |
| `ios/` | The Xcode project. Edit it in Xcode; it is checked in |
| `ios-shell/offline.html` | The page shown when the site can't be reached |
| `.github/workflows/ios-testflight.yml` | Builds the app on a Mac in GitHub and uploads it to TestFlight |

## What you need

- An **Apple Developer Program** membership ($99 a year): <https://developer.apple.com/programs/enroll/>. Enrolment can take a day or two to be approved.
- Either a **Mac with Xcode** (free from the Mac App Store), or no Mac at all, using the GitHub workflow below.

## One-time setup in App Store Connect

1. In <https://developer.apple.com/account/resources/identifiers/list>, add an **App ID** with the bundle ID `info.teddybiere.workstream` (you can use a different ID; change `appId` in `capacitor.config.ts` and the bundle identifier in Xcode to match).
2. In <https://appstoreconnect.apple.com>, choose **Apps → + → New App**: platform iOS, a name (it must be unique on the App Store, so "Workstream" alone may be taken), the bundle ID from step 1, and any SKU, e.g. `workstream-ios`.

## Build and upload without a Mac (GitHub Actions)

1. In App Store Connect, open **Users and Access → Integrations → App Store Connect API**, create a key with the **Admin** role (it needs to create signing certificates), and download the `.p8` file. Note the **Key ID** and the **Issuer ID** shown on that page.
2. Find your **Team ID** at <https://developer.apple.com/account> under Membership details.
3. In GitHub, open the repository's **Settings → Secrets and variables → Actions** and add four secrets:
   - `APPLE_TEAM_ID`: the Team ID
   - `ASC_KEY_ID`: the Key ID
   - `ASC_ISSUER_ID`: the Issuer ID
   - `ASC_KEY_P8`: the whole contents of the `.p8` file, including the `BEGIN` and `END` lines
4. Open **Actions → iOS TestFlight → Run workflow**. It builds and signs the app and uploads it; each run gets the next build number.
5. After Apple processes the build (usually 10 to 30 minutes), it appears in App Store Connect under **TestFlight**. Add yourself as an internal tester and install it with the TestFlight app on your iPhone.

## Build with a Mac

```bash
npm install
npm run ios:sync    # copies the config and offline page into the Xcode project
npm run ios:open    # opens Xcode
```

In Xcode, select the **App** target → **Signing & Capabilities**, tick **Automatically manage signing** and pick your team. Plug in your iPhone and press Run to try it, or choose **Product → Archive** and then **Distribute App → App Store Connect** to upload to TestFlight. Raise the **Build** number in the target's General tab before each upload.

To try the app against a server on your own computer, run `CAP_SERVER_URL=http://192.168.1.20:5173 npm run ios:sync` (your computer's address on the same Wi-Fi), then Run in Xcode. Run `npm run ios:sync` again without it before archiving.

## Submitting to the App Store

When a TestFlight build works well, in App Store Connect fill in the app's description, screenshots (6.9" iPhone at least), a privacy policy URL, the age rating and the App Privacy answers (the app stores an email address and the boards people create, linked to their account, not used for tracking). Then pick the build and **Submit for Review**. Apple needs a demo account to review an app with sign-in, so create one on the site and give its email and password under **App Review Information**.

Apple sometimes rejects apps that are only a website in a frame (guideline 4.2). This app is a full working tool rather than a brochure, which usually passes, but if review pushes back, adding something native, such as push notifications for due cards, is the usual answer.

## Changing the icon, name or site address

- **Icon**: replace `ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png` with a 1024×1024 PNG without transparency.
- **Name under the icon**: `CFBundleDisplayName` in `ios/App/App/Info.plist`.
- **Site address**: `server.url` in `capacitor.config.ts`, and the **Try again** link in `ios-shell/offline.html`; then `npm run ios:sync`.
