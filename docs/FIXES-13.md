# Fixing the 13, then the half-built work

Working notes for this pass, 15 November 2026. `docs/NEXT.md` §2 is the list; `docs/AUDIT.md`
has the detail behind each ID. Every item below is either fixed in the code or left with the
reason it cannot be, so nothing drops off the list quietly.

## The 13

| # | Audit | What changed | Where |
|---|---|---|---|
| 1 | F1 | The test no longer requires 300 days left on the fixture certificate (which made the build go red on 27 Dec 2026 by itself). It asserts a live certificate with room to spare. | `CryptoTests.swift` |
| 2 | C1 | The AFC file-open answer is read with operation **14** (`AFC_OP_FILE_OPEN_RES`), with 2 still accepted. The test now builds 14, the way a phone answers. | `LockdownWire.swift`, `PairingTests.swift` |
| 3 | C13 | Both listeners bind to loopback only, so nobody on the Wi-Fi can fetch the app or post a device ID. `NSLocalNetworkUsageDescription` added. | `InstallServer.swift`, `UDIDReader.swift`, `Info.plist` |
| 4 | C2 | `Range: bytes=-0` is refused instead of building an impossible range and trapping. | `InstallServer.swift` |
| 5 | B1 | `NSAllowsLocalNetworking` is gone, so `NSAllowsArbitraryLoads` actually applies and plain `http://` sources work. | `Info.plist` |
| 6 | E1 | `replaceDylib` writes the new name **in place** when it fits, so no load command moves and no ordinal changes. A longer name is rebuilt inside the header padding with every other command in its original order. | `MachOEdit.swift` |
| 7 | E8 | `Data.u8` and `Data.sub` clamp instead of trapping, so a damaged or hostile `.ipa` reports "malformed" rather than killing the app. | `Bytes.swift` |
| 8 | A1 | The app asked for is carried in `Store.pendingSign`; My apps acts on it in `.task` and `.onChange` as well as on the notification, so a cold launch works. | `SignerApp.swift`, `Store.swift`, `LibraryView.swift` |
| 9 | A2 | Picking, importing, reading an app's info and the install screen's icon read all moved off the main thread, with a "Reading the app…" row instead of a frozen screen. | `SignView.swift`, `FilesView.swift`, `Intake.swift`, `InstallView.swift`, `SigningRunner.swift` |
| 10 | B14 | An update no longer deletes the old copy when it is signed. `Store.replaceAfterInstall` keeps it until the install is handed to iOS (or drops it if the person stops). | `Updates.swift`, `Store.swift`, `InstallView.swift` |
| 11 | B10 | iOS taking the background task away no longer stops the silent audio loop — that loop is what was keeping the job alive. | `KeepAwake.swift` |
| 12 | B8 | One signing job at a time for the whole app (`SigningRunner.jobInFlight`); a second attempt says so instead of clobbering the first. | `SigningRunner.swift` |
| 13 | B2 | The notification permission is asked for at launch when the switch is on, not only when the switch changes. Repeat notices and double-counting are fixed too (B3). | `BackgroundRefresh.swift`, `SignerApp.swift` |

Bonus from the same list: A3 (deleting add-ons removed the wrong ones — `remove(atOffsets:)`),
A5 (the on-phone install no longer silently falls back to the helper), A6 (the address it
answers on can be set), A9 ("Install it now" installs the app that was just signed), A11
(a source can be deleted by long-press), A14 partly (the web-certificate password is in the
Keychain and saved as it is typed) and B7 (a cancelled run deletes its half-written output).

## The half-built work

| What | What was done |
|---|---|
| `.deb` add-ons | **Built.** `Util/Deb.swift` reads the `ar` container and the tar inside it, and takes out every `.dylib`. gzip and stored tar work; **xz and zstd do not** — iOS has no xz decoder, and a full LZMA2 implementation is out of proportion to the job, so those say so plainly and the screen suggests the `.gz` package. zstd uses the system decoder where it exists. Five tests cover it (`DebTests.swift`). |
| Cancelling a sign | **Built.** `IPASigner.cancel()` sets a thread-safe flag that the unpack and pack loops check once per file. The half-written output is deleted. The Sign screen shows "Stop signing". |
| Cancelling an install | **Built.** "Stop installing" ends the listener and every connection, and forgets the pending version swap so the working app is untouched. |
| The on-phone install | **Built.** It refuses instead of falling back, and Settings has the address field. |
| Reading icons out of `Assets.car` | Not done. Needs the five packings documented from real files; the phone itself reads them today, so nothing is broken. |
| The certificate check on a timer | Not done. The button works; a background task is a design decision for the owner. |
| Apple ID sign-in | Not done, on purpose. It means storing an Apple ID and password on the phone, which is the owner's decision. |
| Watch apps | Not done. Signing them correctly needs a watch profile; a warning is the honest half-step and is still missing. |
| App Clips | Not done. Same reason: their own entitlements and profile rules. |
| Batch signing / update-all | Not done. The queue needs the single-job guard (now in place, B8) plus a UI decision. |
| The app's name and icon | Not done. This is the owner's answer, not code (`docs/PLAN.md:44`). |

## What was checked here

- `swift test` on Linux: **132 tests, 40 skipped (they need sample apps that are not in the
  repo), 0 failures.**
- `swiftc -parse` over every file in `App/`: clean. That catches syntax, not types — the
  macOS build in CI is the real check.
- Every new behaviour that can be tested without a phone has a test: the `.deb` reader, the
  stop flag, the AFC answer.