# Plan: the new iOS app signer

The old SNES TAS Studio project was cleared on 24 Oct 2026 (owner's request).
Everything here is our own code, written from scratch. The other signers were taken
apart with REA (Ghidra + Rizin) only to learn what they do — see `docs/RESEARCH.md`.

## Decisions taken so far (all changeable — say the word)
- **Real iPhone app**, SwiftUI, built on GitHub and published as an `.ipa` release.
- **Name "Signer"**, app ID `com.continuum.signer`, minimum iOS 16.
- **Certificates:** your own `.p12` + `.mobileprovision`, and shared ones found online.
- **Own engine** (`Packages/SignKit`), not zsign, which every other signer uses.
- **Installing:** the phone serves the app itself; only a tiny details file (name, ID and a
  link back to the phone) goes through a helper address, because iOS insists that one file
  arrives over HTTPS. Default helper `https://api.palera.in/genPlist`, changeable in
  Settings, with a fully-on-the-phone option for anyone who supplies a web certificate.
- **No tracking.** ESign and GBox both carry Umeng/Bugly/Firebase. We carry nothing.

## Done
- Engine: zip (zip64, symlinks, permissions), Mach-O read/edit, code signing
  (code directory, requirements, entitlements XML + DER, CMS), `CodeResources` matching
  Apple's own output, `.p12` reader (AES / Triple-DES / RC2-40), provisioning profiles,
  X.509, OCSP revocation checks, SHA-1/SHA-256/HMAC, RSA with Montgomery maths.
  78 tests, run on Linux in CI, including forced on-disk signing and streamed archive
  tests for multi-gigabyte apps. Output verified with an outside tool (rcodesign):
  `signature_verifies: true` for the app and every framework inside it.
- Signature shape now matches what Apple's own tool writes (entitlement block, certificate
  chain inside the signature, attributes, rule text, run permission, archive dates) — see
  section 7 of `docs/RESEARCH.md` — plus a built-in installer-style checker that reports
  problems in plain English after every signing.
- App: My apps, Sign, Sources, Certificates, Settings; local install server;
  phone-ID reader; app modifications (name, ID, version, flags, remove extras, tweaks).
- Build: GitHub Actions runs the engine tests, builds the `.ipa`, publishes a release.

## Next, in order
1. **Certificate checking on a timer** with a warning before it dies.
2. **Batch signing** and "update all" for apps that came from a source.
3. **Clones** — several copies of one app side by side (ESign's "App Multi-Open").
4. **Files screen**: look inside an `.ipa`, edit an Info.plist, swap an icon.
5. **ESign-format sources** (theirs are scrambled; Feather worked out how, we have not yet).
6. **Apple account sign-in** to make certificates and profiles in the app (what GBox does).
7. **Pairing-file install** (the way SideStore and Feather install without any helper).

## Open questions for the owner
- Do you want the app's name and icon changed from the placeholder "Signer"?
- Shared certificates: should the app fetch a list from somewhere, or only take files
  you import yourself?
- Is the default helper address fine, or would you rather we host that bit ourselves?
