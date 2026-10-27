# Every feature, against every other signer

The owner's rule (26 October 2026): "I want it to have All the features and more. If there's a
signer out there that can do something, I want mine to be able to do it as well."

The signers compared: ESign, GBox/GBoxPlus, Feather, KSign, Scarlet, KravaSigner, ForgeSign,
BuildBox, BatSign, ABox, SideStore. Each line below is a feature one of them has.

## Signer already does this

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
| Remove a linked library by name | ABox | same |
| Separate copy: a new random ID so it installs beside the original (PPQ protection) | KSign, ABox (cloning) | `separateCopy`, 26 Oct |
| Ad-hoc signing with no certificate | Feather | `SigningOptions.adhoc` |
| Multi-gigabyte apps streamed end to end, ZIP64 | nobody (ESign chokes) | `Zip/`, `HugeAppTests` |
| Repositories (AltStore-style JSON) with downloads | Feather, KSign, ESign | `Model/SourceFeed.swift` |
| Install from the phone: own HTTPS, or the small details file through a helper | Feather, ForgeSign | `Install/InstallServer.swift` |
| Reads the phone's UDID with no computer | ESign | `Install/UDIDReader.swift` |
| File tab, imports from anywhere | ESign, GBox | `Views/FilesView.swift` |
| Install as soon as it is signed | ESign | 26 Oct |
| A trace file for a job iOS kills | nobody | `Util/Trace.swift` |
| Signer's own look: light, dark, or follow the phone | ESign, Feather, KSign | `Model/Appearance.swift`, 26 Oct |
| Apps and signing on one screen, no empty Sign tab | GBox, KSign | `Views/LibraryView.swift`, 26 Oct |
| Clears the gigabytes a killed signing run leaves behind | nobody | `IPASigner.clearLeftovers`, 26 Oct |

## Done since this list was written

1. ~~**Updates for repository apps.**~~ Done 26 October: My apps says "2.1 waiting" and Update
   downloads, signs and installs in one tap; the Sources tab says Update or Added. Version
   comparison is `Util/Version.swift` in the engine, with tests.
3. ~~**An entitlements editor.**~~ Done 26 October: Sign → Permissions. Shows what the
   certificate's profile allows in plain words, one-tap switches for the useful extras (debugger,
   extra memory, large addresses, JIT with a warning), and anything else by name and value.
   `Views/EntitlementsView.swift`; proved to reach the signature inside the app by
   `testExtraPermissionsReachTheSignature`.

## Still to build, in the order it is worth doing

2. **ESign-format repositories**, including the encrypted ones. The plain ones already work: the
   two real ESign feeds checked on 26 October (`esign.yyyue.xyz/app.json` and friends) are
   AltStore-shaped, and `versionDescription` (what's new) and text sizes are read now too.
   The **encrypted** ones are blocked on a real example - nothing public spells the format out,
   and guessing it is pointless. Needs an encrypted ESign repo address to work from.
4. **Reading an icon out of `Assets.car`.** Half of this item is done (26 October): there is an
   icon picker on the Sign screen - a photo, a picture file, or one of the app's own alternative
   icons (`CFBundleAlternateIcons`) - and a new icon no longer deletes the app's compiled image
   set, which is what makes other signers' "icon fix" lose every picture in an app. What is left
   is *reading* an icon that exists only inside `Assets.car`, for apps that show up blank. That
   needs a reader for Apple's compiled catalogue format (BOM trees, CSI renditions, LZVN), which
   is a large piece of engine work; all four real apps checked here ship loose icon files, so it
   is rare. Worth doing only when an app actually turns up blank.
5. **A Mach-O viewer**: every library an app links, with one tap to remove one, and what the
   signature inside says. (ABox.)
6. **Editing inside an app before signing**: unzip, change a `.plist`, repack. (ESign, GBox.)
7. **Progress in the Dynamic Island** while a big app signs. (BatSign.) Needs a Live Activity,
   which is an extension — check it against a one-app-ID certificate first.
8. **An installed-apps list** with what came from which repository and what is out of date.
9. **classdump**: export `.h` headers from a binary. (ABox.)
10. **Install over a pairing file (AFC)**, the way SideStore does, as a second route when the
    details-file install is refused.
11. **Shortcuts actions** (sign a file, install it) and refreshing repositories in the background.
