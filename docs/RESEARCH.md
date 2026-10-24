# What the other signers actually do

Everything below was checked by me in the sandbox on 24 Oct 2026, using REA
(`rea-agents` 6.7.0) with Ghidra 12.1.4 and Rizin as its engines, plus real
`.ipa` files pulled down and unpacked. Open projects were read as source; the
closed ones (ESign 5.0.2, GBox 6.1.3) were taken apart as binaries.

Apps examined: **ESign 5.0.2** (closed), **GBox 6.1.3** (closed), **Feather 2.9.0**,
**KSign**, **VexSign**, **SideStore**, plus the source of ForgeSign, SwiftIPA, Wax,
BatSign, ProSign and zsign.

## 1. How each one installs an app on the phone

Every on-device signer uses the same Apple mechanism: an `itms-services://` link
pointing at a small manifest file (a `.plist`) that says where the `.ipa` is.
iOS requires that manifest to come over valid HTTPS.

Confirmed strings inside GBox's binary:

- `itms-services://?action=download-manifest&url=`
- `itms-services:///?action=download-manifest&url=%@`

The difference between the apps is only *where that manifest lives*:

| Approach | Who does it | Catch |
|---|---|---|
| Local web server on the phone with a real HTTPS certificate for a name that resolves to 127.0.0.1 | Feather (`*.backloop.dev`), Wax | Needs extra entitlements on iOS 18+; the shared certificate can be pulled |
| Plain local server for the `.ipa` + a remote HTTPS server for the manifest | Feather fallback, ForgeSign (`api.palera.in`), SwiftIPA | Needs that remote site up; it sees your manifest |
| Fully remote | the websites that hand out ESign and GBox themselves (`esign.yyyue.xyz`, `applep12.com`, `gbox.run/Public/gbox.plist`) | Their server, their rules |

Correction to an earlier note: those remote addresses are how **ESign and GBox get
installed onto the phone in the first place**, not how they install the apps you sign
inside them. Inside, ESign's own code uses a local server (`http://localhost:%@`,
`http://%@:%i/`) exactly as Feather does — the same shape we use.
| Pairing file + VPN, install through `installd` over AFC, like a computer would | Feather's second method, SideStore | Needs a one-time setup on a computer |

Feather's own notes confirm a further wrinkle: on newer iOS they have to open a
local HTML page in a Safari web view that redirects to the `itms-services://`
link, because the app itself can no longer open it directly. Apple's developer
forums also have reports that on iOS 26.5–26.7 the install sits at "Waiting…"
until the app is force-quit, so our installer must handle that case and say so
plainly instead of spinning forever.

**For us:** local server + local HTTPS first, remote manifest as a fallback,
pairing/AFC install as the most reliable option for anyone who can do the one-time
setup, and a clear, honest message when iOS stalls.

## 2. The UDID trick (ESign)

Shipped inside ESign.app is `signed.mobileconfig` — a "Profile Service" payload:

```
URL = http://127.0.0.1:14302/udid
DeviceAttributes = (UDID)
PayloadIdentifier = xyz.yyyue.profile-service
```

So ESign runs a local server on port 14302, hands iOS a configuration profile,
and iOS posts the device's UDID straight back to the app. That is how it gets a
UDID with no computer. GBox instead sends you to `https://gbox.run/tool/getUdid`.
We will do the local-only version — nothing leaves the phone.

## 3. Certificates and revocation

- ESign ships `root.pem`, `cert_cert.pem` and `cert_key.pem`, and its strings
  include a notice about finding "a new free enterprise certificate … shared
  online", so it hands out shared certificates and warns they may not be trusted.
- ESign links a full OpenSSL with the **OCSP** code in use (`OCSP_sendreq_bio`,
  `OCSP_check_validity`, `OCSP_basic_verify`): that is how it reports "Cert.Revoked".
  This is the real revocation check, not just an expiry date. VexSign and SwiftIPA
  admit they only check the expiry.
- GBox ships `apple-ios.pem` / `apple-iosn.pem` and talks to
  `developerservices2.apple.com` (`listTeams.action`, `viewDeveloper.action`,
  `clientId=XABBG36SBA`) and `idmsa.apple.com` — i.e. it signs you into an Apple
  account and makes certificates and profiles itself, like AltStore does.

**For us:** real OCSP revocation checks, expiry countdown, entitlement and device
list viewer, and (later) Apple-account provisioning.

## 4. The signing engine

GBox's binary still carries zsign's error strings verbatim:

```
>>> Build CodeSignature failed!
>>> Can't find CodeSignature segment!
>>> Can't find free space of LoadCommands for CodeSignature!
>>> Can't find free space of LoadCommands for LC_LOAD_DYLIB or LC_LOAD_WEAK_DYLIB!
>>> Can't load p12 or private key file. Please input the correct file and password!
```

So GBox is zsign inside. Feather, KSign, VexSign and ProSign all say openly that
they use the Zsign package. **Everyone is running the same engine.** That is the
one real opening: our engine is written from scratch in Swift (`Packages/SignKit`),
so it can do things zsign cannot — per-file progress, cancel mid-way, resign only
what changed, and plain-English errors instead of `>>>` dumps.

Facts the engine has to honour, read off the real apps:

- `_CodeSignature/CodeResources` carries four sections: `rules`, `files` (SHA-1
  digests), `rules2`, `files2` (SHA-256 digests). `Info.plist` and `PkgInfo` appear
  in `files` but are **omitted** from `files2`; `.lproj` files are `optional`;
  `.DS_Store` and `locversion.plist` are omitted; `embedded.provisionprofile` and
  `version.plist` carry weight 20.
- Nested code (`Frameworks/*.framework`, `*.dylib`, PlugIns) is listed in `files2`
  with `hash2` only and is signed on its own first, innermost first.
- Both apps are arm64-only, not encrypted, and leave 7.5–10.6 KB of free space in
  the Mach-O header — which is what limits how many libraries can be injected.

Our Mach-O reader was checked against `llvm-otool` on all four apps: same command
count, same signature offset and size, same library list and order.

## 5. What the closed apps send home (and we will not)

- **ESign**: Umeng (`ulogs.umeng.com`, `aspect-upush.umeng.com`), Tencent Bugly
  (`ios.bugly.qq.com`), QMUI usage reporting, OpenUDID.
- **GBox**: Firebase/Google analytics (`app-measurement.com`,
  `app-analytics-services.com`), Bugly, Umeng, `apiv2.vendorcode.club`, plus
  Alibaba and Tencent endpoints.

Feather and KSign are clean on that front, and so are we: no analytics, no
tracking, nothing phoning home.

## 6. Features worth copying

Pulled from all of them, for our list in `PLAN.md`: batch signing and queues,
signing presets, clones of one app ("App Multi-Open"), `.deb`/`.dylib`/framework
injection with an ElleKit replacement for Substrate, IPA explorer with a plist
editor, repositories in both AltStore and ESign formats (ESign's are encrypted —
Feather's `AltSourceKit` already works out how), update tracking, background
downloads, certificate dashboard, Face ID lock, and Shortcuts/widgets.
