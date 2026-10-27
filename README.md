# Signer

An iPhone app that signs other iPhone apps, on the phone, with no computer.

Everything here is written from scratch. The signing engine is ours — not zsign,
which every other on-device signer (ESign, GBox, Feather, KSign, VexSign, ProSign)
runs underneath. See [docs/RESEARCH.md](docs/RESEARCH.md) for what the others do and
how that was worked out, and [docs/PLAN.md](docs/PLAN.md) for where this is going.

## What it does today

- **Signs apps on the phone.** Its own engine: zip, Mach-O, code directory, requirements,
  entitlements (both the old XML and the newer DER form), CMS signature, and the
  `CodeResources` list that matches what Apple's own tool writes.
- **Reads real certificate files.** `.p12` files including the old RC2-40 kind iOS itself
  often refuses, with a plain reason when something is wrong instead of "unknown error".
- **Says when a certificate is dead.** Asks Apple directly (OCSP), so a certificate that
  has been switched off is caught even while its end date still looks fine.
- **Checks its own work the way the iPhone's installer does.** After signing, it re-reads
  the finished app and shows a plain "Check failed — …" line for anything iOS would refuse,
  instead of iOS's vague "integrity could not be verified".
- **Changes apps while signing**: name, app ID, version, icon, minimum iOS, file sharing,
  120 Hz, remove extras, remove the Watch app, add `.dylib`/`.deb` add-ons.
- **A new icon without wrecking the app.** A photo, a picture file, or one of the icons the
  app already carries for itself; the app's compiled image set is left alone, which is what
  other signers' "icon fix" destroys.
- **A permissions editor.** What the certificate's profile allows, in plain words, plus
  switches for the useful extras (debugger, extra memory, large addresses, JIT) and anything
  else by name.
- **Shows what is inside an app**: every program in it, everything each one links, what its
  signature says, and one tap to take a carried library out.
- **Keeps source apps up to date.** My apps says when a source has a newer version; one tap
  downloads it, signs it and installs it.
- **Light, dark, or follow the phone.**
- **Handles multi-gigabyte apps.** Imports, downloads, unpacking, resource hashing,
  Mach-O signing, packing and installation all stream in small chunks. A 2 GB app is
  never loaded into memory; ZIP64 covers archives that pass 4 GB; long jobs stay alive
  when the screen locks; disk room is checked from the real unpacked sizes first.
- **Installs from the phone itself.** The app is served by the phone; nothing is uploaded.
- **Reads the phone's own ID** with no computer.

## Layout

| Path | What it is |
|---|---|
| `Packages/SignKit` | The signing engine. Plain Swift, no third-party code. Tests run on Linux. |
| `App` | The iPhone app (SwiftUI). The Xcode project is generated from `App/project.yml`. |
| `tools/verify-signature.sh` | Checks a signed `.ipa` with an outside tool. |
| `.github/workflows/build.yml` | Runs the engine tests, builds the `.ipa`, publishes it. |

## Checking the engine

```sh
swift test --package-path Packages/SignKit          # 99 tests, runs on Linux
Packages/SignKit/.build/debug/signkit-cli zip x.ipa # read any .ipa, verify every checksum
signkit-cli sign-ipa in.ipa out.ipa cert.p12 pw     # sign end to end
RCODESIGN=/path/to/rcodesign tools/verify-signature.sh out.ipa
```

The engine is not graded on its own homework: signed output is checked with
[rcodesign](https://github.com/indygreg/apple-platform-rs), an unrelated tool, which
reports `signature_verifies: true` for the app and every framework inside it.

## Honest limits

- Signing needs your own certificate (a `.p12`, usually with a `.mobileprovision`).
  Free shared certificates work too, and die when Apple turns them off.
- An app still locked by the App Store cannot be re-signed into a working app; you need a
  decrypted copy. The app says so before wasting your time.
- Installing needs one of two things set up: a web certificate for a local address, or a
  helper address for the small details file. iOS insists that one file arrives over HTTPS.
- On some recent iOS versions the install can sit at "Waiting…" until Signer is closed.
  That is iOS, not us; the app tells you what to do.
