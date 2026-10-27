# Every feature, against every other signer

The owner's rule (26 October 2026): "I want it to have All the features and more. If there's a
signer out there that can do something, I want mine to be able to do it as well."

The signers compared: ESign, GBox/GBoxPlus, Feather, KSign, Scarlet, KravaSigner, ForgeSign,
BuildBox, BatSign, ABox, SideStore. Each line below is a feature one of them has.

**The list of eleven missing features is finished.** Everything below is built. What is left is
in "Still not possible on a phone" at the bottom, with the reason.

## Signer does this

| Feature | Who else has it | Where ours lives |
|---|---|---|
| Own signing engine, no zsign | nobody else (all the open ones vendor zsign) | `Packages/SignKit` |
| `.p12` import, including RC2-40 | all | `Certs/PKCS12.swift` |
| Passwords kept in the iPhone Keychain | ForgeSign | `Model/SecretStore.swift` |
| Asks Apple whether a certificate is switched off (OCSP) | ESign | `Certs/OCSP.swift` |
| Checks its own finished app the way the installer does | nobody | `Signing/SignatureInspector.swift` |
| Several certificates, switching between them | Feather, KSign | `Views/CertificatesView.swift` |
| Days-left and expiry shown | ForgeSign (as a pill) | certificate rows |
| Name, ID, version, build number, icon, minimum iOS | all | `Signing/SigningOptions.swift` |
| File Sharing, iTunes sharing, 120 Hz, Game Mode, iPad full screen, light/dark, Liquid Glass | KSign, Feather | same |
| Remove URL schemes, device restrictions, extensions, the Watch app, chosen files | ESign, GBox | `Signing/Modifier.swift` |
| Thin to one architecture | ABox | same |
| Inject `.dylib`/`.deb`, into extensions too, custom path, Substrate→ElleKit | all | same |
| Remove a linked library by name | ABox | `Views/InsideAppView.swift` + `removeLibraries` |
| Separate copy: a new random ID so it installs beside the original (PPQ protection) | KSign, ABox (cloning) | `separateCopy` |
| Ad-hoc signing with no certificate | Feather | `SigningOptions.adhoc` |
| Multi-gigabyte apps streamed end to end, ZIP64 | nobody (ESign chokes) | `Zip/`, `HugeAppTests` |
| Repositories (AltStore-style JSON) with downloads | Feather, KSign, ESign | `Model/SourceFeed.swift` |
| Install from the phone: own HTTPS, or the small details file through a helper | Feather, ForgeSign | `Install/InstallServer.swift` |
| Reads the phone's UDID with no computer | ESign | `Install/UDIDReader.swift` |
| File tab, imports from anywhere | ESign, GBox | `Views/FilesView.swift` |
| Install as soon as it is signed | ESign | 26 Oct |
| A trace file for a job iOS kills | nobody | `Util/Trace.swift` |
| Signer's own look: light, dark, or follow the phone | ESign, Feather, KSign | `Model/Appearance.swift` |
| Apps and signing on one screen, no empty Sign tab | GBox, KSign | `Views/LibraryView.swift` |
| Clears the gigabytes a killed signing run leaves behind | nobody | `IPASigner.clearLeftovers` |
| **Updates for repository apps**, one tap to download, sign and install | BatSign, Feather | `Model/Updates.swift`, `Util/Version.swift` |
| **A permissions editor**, with the profile's own permissions shown in plain words | ESign (list only) | `Views/EntitlementsView.swift` |
| **An icon picker**: a photo, a picture file, or the app's own alternative icons | KSign, Feather, ABox | `Views/SignView.swift` |
| **A new icon that does not wipe the app's pictures** | nobody (all delete `Assets.car`) | `Modifier.writeIcon` |
| **Reads an icon out of `Assets.car`**, so no app is ever blank | KSign, ABox | `Signing/AssetCatalog.swift`, `Model/IconReader.swift` |
| **What is inside an app**: every program, what it links, what its signature says | ABox | `Views/InsideAppView.swift`, `Signing/BinaryReport.swift` |
| **Editing files inside an app before signing** (`.plist` and any text) | ESign, GBox | `Views/AppFilesView.swift`, `Signing/AppContents.swift` |
| **classdump**: headers out of a program, Swift names unpacked | ABox | `MachO/ObjCDump.swift`, `Views/HeadersView.swift` |
| **ESign's encrypted repo codes**, and KravaSign's, MapleSign's, FlareStore's - read and written | FlareStore (reads only) | `Util/ShareCode.swift` |
| **Progress in the Dynamic Island** and on the lock screen | BatSign | `App/SignerActivity`, `Model/SigningIsland.swift` |
| **An installed-apps list** saying which repository each app came from | BatSign | `Views/LibraryView.swift` |
| **Shortcuts actions** and Siri: sign, install, check sources, updates waiting | nobody | `Model/SignerIntents.swift` |
| **Repositories checked in the background**, with a notification | BatSign | `Model/BackgroundRefresh.swift` |
| **Installing over a pairing file**, the way SideStore does | SideStore | `Install/LockdownClient.swift`, `Install/DeviceInstaller.swift` |

## Still not possible on a phone, and why

- **The tunnel for pairing-file installs.** The protocol is all here and the pairing file is
  read, but iOS's own install service only answers a connection that arrives through a network
  interface, which is why SideStore ships a separate VPN app (StosVPN) to make one. Doing that
  inside Signer needs Apple's network-extension entitlement, which a developer certificate does
  not grant. With a tunnel app running, Settings → Pairing file → "Say hello" answers and the
  install works; without one it cannot. Say hello first; it says exactly what happened.
- **Apple's own picture packings in `Assets.car`.** Five different ones turn up in four real
  apps and none is written down. Rather than guess, the file is handed to iOS, which has the
  only complete reader - so icons come out right, but on the phone rather than in the engine.
  On a computer (the tests) only the plain, zlib, PNG and JPEG ones unpack.
