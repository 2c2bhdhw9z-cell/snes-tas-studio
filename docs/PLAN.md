# Plan: the new iOS app signer

The old SNES TAS Studio project was cleared on 24 Oct 2026 (owner's request).
Everything here is our own code, written from scratch. Other signers were studied
(with REA, Ghidra and Rizin) only to learn what they do and how.

## Decisions so far
- Real iPhone app (SwiftUI). Built by GitHub Actions on a Mac runner, delivered as an `.ipa`.
- Certificates: the owner's own `.p12` + `.mobileprovision`, and shared ones found online. Both.
- Every feature the top signers have, plus more (list below).
- Working names (easy to change later): app **"Signer"**, bundle ID `com.continuum.signer`.

## Parts
1. **SignKit** (`Packages/SignKit`): our signing engine. ZIP read/write, Mach-O, code
   signature (CodeDirectory SHA-1 + SHA-256, requirements, entitlements XML + DER, CMS),
   `_CodeSignature/CodeResources`, nested apps/frameworks/extensions, PKCS#12 reader,
   provisioning profile reader, X.509 reader, OCSP revocation check. Tested on Linux with
   `swift test` and checked with an independent verifier (rcodesign).
2. **App** (`App/`): Library, Sign, Install, Certificates, Sources, Downloads, Files, Settings.
3. **Install**: local web server on the phone + `itms-services` link (how ESign, Feather and
   KSign all do it), with a fallback page in Safari for iOS 26.5+ where the install waits.
4. **Build**: `.github/workflows/build.yml` makes the `.ipa` and posts it as a GitHub release.

## Feature list (from studying ESign, GBox, Scarlet, Feather, KSign, VexSign, ForgeSign, SwiftIPA)
- Sign + install on the phone, batch signing, re-sign/update all.
- Change name, bundle ID, version, icon, minimum iOS, appearance; remove extensions,
  Watch app, URL schemes, device limits; file sharing; ProMotion; Game Mode; iPad full screen.
- Clones ("App Multi-Open" in ESign): many copies of one app with different IDs.
- Tweaks: inject `.dylib`, `.deb`, `.framework`; remove injected libraries.
- Certificates: import p12 + profile, password check, expiry countdown, revoked check
  (OCSP, like ESign), entitlement and device list viewer.
- Get the phone's UDID with no computer (ESign trick: a profile that sends the UDID back
  to the app's own local server).
- Sources: AltStore/SideStore/Feather format and ESign format, app browser, search, updates.
- Downloads from links and from a built-in browser; Files manager; plist editor.
- Apple ID sign-in to make certificates/profiles (GBox does this with Apple's developer
  services API) — later stage.

## Research notes
See `docs/RESEARCH.md`.
