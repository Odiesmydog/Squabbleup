# Getting SquabbleUP on the iOS App Store

A start-to-finish checklist. The app code is already prepared — premium gating,
Apple receipt verification, Restore Purchases, and account deletion are all built in.
What's left is mostly Apple-side setup.

## 0. What's already done in this repo

- **Free tier**: 3 lifetime squabbles (creates + lobby joins). Server-enforced.
- **Premium ($1, one-time)**: unlimited squabbles, friends list, handshake mode.
- **IAP hooks**: the client buys product `com.squabbleup.premium` through StoreKit
  (via cordova-plugin-purchase) and the server verifies the receipt with Apple at
  `POST /api/premium/apple-verify` before unlocking.
- **Restore purchase** button (required by Apple for non-consumables).
- **Account deletion** in Profile (required by guideline 5.1.1(v) for any app with accounts).
- **Promo code unlock** (`POST /api/premium/redeem`) — web only, hidden inside the
  native app so it doesn't violate the IAP-only rule. Set `PREMIUM_PROMO_CODE` on
  Render to enable it for testing; unset to disable.

## 1. Apple Developer account (~1 day for approval)

1. Enroll at https://developer.apple.com/programs/ — $99/year. Use your personal
   name or an LLC (an LLC needs a D-U-N-S number; personal is fine to start).
2. Once approved you get access to **App Store Connect** (appstoreconnect.apple.com).

## 2. Wrap the web app in a native shell (Capacitor)

You need a Mac with Xcode (App Store → install "Xcode", it's huge). Then in this repo:

```bash
npm install @capacitor/core @capacitor/cli
npx cap init SquabbleUP com.squabbleup.app --web-dir public
npm install @capacitor/ios cordova-plugin-purchase
npx cap add ios
npx cap sync
npx cap open ios   # opens Xcode
```

Important choices:
- **Bundle ID**: `com.squabbleup.app` (must match App Store Connect exactly; can never change).
- Point the shell at your live server instead of bundling files: in
  `capacitor.config.json` add `"server": { "url": "https://squabbleup.onrender.com" }`.
  This means app updates ship instantly via Render — no App Store review for content
  changes. (Apple allows this for web-tech apps as long as core behavior doesn't change.)
- In Xcode: select the project → Signing & Capabilities → pick your team, and add the
  **In-App Purchase** capability. Add **Push Notifications** capability only if you wire
  up native APNs later (web push does not work inside the shell).

## 3. Create the app + IAP in App Store Connect

1. **My Apps → "+" → New App**: platform iOS, name "SquabbleUP", bundle ID from above.
2. **Monetization → In-App Purchases → "+"**:
   - Type: **Non-Consumable**
   - Product ID: `com.squabbleup.premium` (must match `PREMIUM_PRODUCT_ID` in the code)
   - Price: pick the $0.99 tier — Apple's pricing is tiered; $0.99 is the closest to $1.
     (There is also a $1.00 price point in the newer pricing system if you want exactly $1.)
   - Add display name ("SquabbleUP Premium") and description, and a review screenshot
     (screenshot of the premium modal is fine).
3. **App Information → App-Specific Shared Secret → generate**, then on Render add
   env var `APPLE_SHARED_SECRET=<that value>`. Receipt verification fails without it.
4. Optionally set `PREMIUM_PRODUCT_ID` on Render if you used a different product ID.

## 4. Things Apple checks that are already handled — verify they work

- [ ] Buy premium in sandbox → premium unlocks (create a **Sandbox tester** account
      under Users & Access → Sandbox, sign into it on your test device).
- [ ] "Restore purchase" works after deleting/reinstalling the app.
- [ ] Delete account from Profile actually deletes and resets the app.
- [ ] Free user hitting a 4th squabble sees the upgrade sheet, not a dead end.

## 5. Things you still need to provide

- [ ] **Privacy policy URL** (required). A simple page covering: what's stored
      (username, avatar, drafts, friends, push subscriptions), no email/password,
      account deletion available in-app. Host it at /privacy on the site.
- [ ] **Support URL** (a page or even a mailto link).
- [ ] **App Privacy questionnaire** in App Store Connect: you collect "User Content"
      (chat, profile) and "Identifiers" (a random user ID) — not linked to identity,
      not used for tracking.
- [ ] **Screenshots**: 6.7" (iPhone Pro Max) and 6.1" sizes minimum. Run in the iOS
      Simulator and screenshot the lobby, a live draft, and a matchup.
- [ ] **Age rating questionnaire**: answer "Yes" to *simulated gambling: no* — but see
      the handshake warning below. Fantasy sports contests → 17+ is the safe rating.

## 6. ⚠️ Review risks specific to SquabbleUP — read this

1. **Handshake mode looks like wagering.** Apple guideline 5.3 is strict about real-money
   gaming. The app never touches money, but a field that says `"$10 each"` can read like
   facilitating a bet. Mitigations if the reviewer pushes back:
   - the placeholder already includes non-money examples ("winner buys drinks");
   - be ready to reframe it as "friendly stakes / bragging rights" and drop the "$"
     example from the placeholder;
   - worst case, hide handshake mode on iOS builds only.
   Don't volunteer the word "bet" anywhere in the listing.
2. **Accounts are device-bound** (no login). That's allowed, but the reviewer may lose
   state between sessions — mention in Review Notes that the account is created silently.
3. **Review notes**: give the reviewer a premium-unlocked flow — either tell them the
   sandbox purchase works, or temporarily set `PREMIUM_PROMO_CODE` and include it in the
   notes... **don't** — the promo box is hidden on iOS. Just let them use the sandbox IAP.
4. **Web push doesn't exist inside the shell.** The "Enable notifications" button will
   no-op in the native app. Either hide it on native (`window.Capacitor`) or wire native
   push before submitting, so the reviewer doesn't see a broken button.

## 7. Build, test, submit

```bash
npx cap sync ios && npx cap open ios
```
1. In Xcode: Product → Archive → Distribute App → App Store Connect → Upload.
2. In App Store Connect: TestFlight tab → install on your own phone, test the real
   sandbox purchase end-to-end.
3. App Store tab → create version 1.0 → attach the build, fill everything from §5,
   add the IAP to the version, submit for review.
4. Typical review time: 1–2 days. First submissions often get one rejection — read the
   message, fix, resubmit; it's normal.

## Costs recap

- Apple Developer Program: $99/year
- Apple's cut of the $1 IAP: 30% (15% once you enroll in the Small Business Program —
  do this, it's free: App Store Connect → Agreements)
