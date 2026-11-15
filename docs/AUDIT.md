# The whole repo, read line by line — and everything found

15 November 2026. Commit `6f82d94`, branch `main`.

Every text file in the repo was read from its first line to its last: 123 files, about
18,800 lines. The engine's tests were then run on a Linux computer, and GitHub was checked
for branches, pull requests, releases and workflow runs. Nothing in the code was changed;
this document is what was found.

It is deliberately exhaustive: **137 entries**, 20 of them High. Some entries are certain
(the code was read and the problem is visible in it). Others are marked **suspected** or
**needs a device**: they follow from the code but could not be tested from here, because
they need a real iPhone, a real `.ipa`, or a tunnel app. They are kept anyway — that is the
point of the list. Every entry says which kind it is, so nobody has to guess later.

**Legend**

| Mark | Means |
|---|---|
| **High** | Breaks a main job (install, sign, launch), or crashes the app |
| **Medium** | Wrong result or a job that cannot finish in some real case |
| **Low** | Cosmetic, dead code, or a rough edge |
| **in the code** | Read straight out of the source; no guesswork |
| **suspected** | Follows from the code but needs a run to prove it |
| **needs a device** | Only an iPhone can settle it |
| **external check** | Compared against a third-party spec or source (named in the entry) |

IDs (`A1`, `C1`, `E3`, …) are stable. Refer to them when fixing something, so the fix and
the entry can be tied together.

---

## 0. Snapshot of what the repo is today

### The machine and the test run

```
swift test --package-path Packages/SignKit
→ Executed 126 tests, with 40 tests skipped and 0 failures, in 11.9 s
```

**86 tests actually run; 40 skip themselves** because they need sample `.ipa` files that
are not in the repo (details in section F). Swift 6.4.2 on Linux x86-64, 8 cores, 8 GB of
memory, 82 GB free.

### GitHub

- **Branches:** `main` only, at `6f82d942`. No pull requests, open or closed.
- **Commits:** 114 in all, 40 of them `Set up MAIPA-G Autonomous [skip ci]`. The last real
  code change is `50f6e66` "Verify injected add-ons in the signed IPA" on 2 Nov; the 22
  commits after it are all MAIPA-G setup.
- **Workflow runs:** 35. The latest is build `#33`, success, 2 Nov 03:31–03:34 UTC.
- **Releases:** `build-33` (latest — `Signer.ipa`, 1,605,777 bytes) and `build-30`
  (1,516,740 bytes, 6 downloads).

### Layout, by size

| Path | Files | Lines | What it is |
|---|---|---|---|
| `Packages/SignKit/Sources/SignKit/Signing/` | 14 | 3,073 | The signing pipeline |
| `Packages/SignKit/Sources/SignKit/MachO/` | 3 | 1,073 | Mach-O read, edit, class-dump |
| `Packages/SignKit/Sources/SignKit/Zip/` | 2 | 763 | Zip read/write, ZIP64, streaming |
| `Packages/SignKit/Sources/SignKit/Crypto/` | 7 | ~620 | SHA, AES, DES, RC2, RSA, PBKDF2, BigInt |
| `Packages/SignKit/Sources/SignKit/Certs/` | 7 | ~1,020 | `.p12`, X.509, profiles, OCSP, Apple's roots |
| `Packages/SignKit/Sources/SignKit/Install/` | 2 | 281 | Lockdown and AFC wire formats |
| `Packages/SignKit/Sources/SignKit/Util/` | 4 | ~476 | Share codes, trace, bytes, versions |
| `App/Signer/Views/` | 12 | 3,180 | Every screen |
| `App/Signer/Model/` | 18 | 1,716 | State, imports, updates, intents, island |
| `App/Signer/Install/` | 5 | ~1,150 | The three install roads |
| `App/SignerActivity/` + `App/Shared/` | 4 | 135 | Dynamic Island extension |
| `Packages/SignKit/Tests/` | 23 | 2,600 | 126 tests in 25 classes |
| `docs/` | 4 | 372 | Research, decisions, features, plan |
| `tools/` | 4 | 299 | Icon, fixtures, Apple certs, signature check |

### The four tabs and what pushes what

```
File ─ confirmationDialog per file
     ├ sheet FileViewer (text)
     └ sheet FileViewer (hex)
My apps ─ push SignView(preselected:)
     ├ InsideAppView → HeadersView → HeaderTextView
     ├ AppFilesView ─ sheet PlistEditorView
     │              └ sheet TextFileEditorView
     └ EntitlementsView
Sources ─ sheet AddSourcesView
     └ push SourceAppsView
Settings ─ UDIDView
     ├ CertificatesView → CertificateDetailView
     └ TraceView
Root ─ sheet InstallView  (only place the install sheet lives)
```

Minimum iOS is 16.0 (`App/project.yml:7`); the Live Activity target asks for 16.1
(`:50`). SignKit is iOS 16 / macOS 13 (`Packages/SignKit/Package.swift:8`).

### Signing, in the exact order it happens

`IPASigner.sign` (`Signing/IPASigner.swift:34-166`):

1. Work folder `tmp/signkit-<UUID>`, deleted by a `defer` at the end (`:38-40`).
2. Open the zip; check free space = unpacked size + biggest entry + max(256 MB, input/10)
   (`:50-66`). Skipped if the free-space figure reads as 0.
3. Unpack, progress 0.02 → 0.27; find the first `*.app` under `Payload/` (`:69-82`).
4. Profile warnings only — never blocks (`:88-110`).
5. `Modifier.apply` (`:111`): removals → `replaceFiles` → old-signature junk sweep →
   Info.plist edits → binary edits.
6. Entitlements: profile's own, then `extraEntitlements` on top (`:114-127`).
7. `BundleSigner.sign` (`:119-128`), progress 0.35 → 0.75: nested bundles innermost first,
   loose Mach-O files, then `CodeResources`, then the bundle's own binary.
8. `SignatureInspector` re-reads the result (`:136-138`). Problems become warnings only.
9. Re-zip, progress to 1.

Per binary: `MachOSigner` in memory, or `MachOFileSigner` on disk above
`diskThreshold` — code directory, requirements, entitlements (XML + DER), CMS, signature
blob, then the `__LINKEDIT` fix-up.

### The three install roads

| Road | Where | What it needs |
|---|---|---|
| Helper manifest (default) | `Install/InstallServer.swift` + `api.palera.in` | The outside helper being up |
| Local HTTPS | same file, `Route.localHTTPS` | A web cert `.p12` in `AppSupport/Signer/local-https.p12` |
| Pairing file | `LockdownClient.swift`, `DeviceInstaller.swift` | A pairing file **and** a tunnel app — iOS only answers on a network interface |

The phone serves the `.ipa` itself in all three; only the tiny manifest goes out.

### Data that is kept, and where

**Settings (`UserDefaults`):** `appTheme` (system), `writeTrace` (true),
`installAfterSigning` (true), `showIsland` (true), `checkSourcesInBackground` (true),
`keepLongJobsRunning` (true), `compressOutput` (false), `installHelperURL`
(`https://api.palera.in/genPlist`), `installLocalHTTPS` (false), `localHTTPSPassword`
(plain text — see C9), `pairingHost` (`127.0.0.1`), `pairingPort` (62078),
`localHTTPSHost` (never written; see C8).

**Files:** `AppSupport/Signer/state.json`; `Certificates/<uuid>/cert.p12`;
`Profiles/<uuid>.mobileprovision`; `Apps/signed-*.ipa`, `Apps/import-*.ipa`, `Apps/*.png`;
`Tweaks/*`; `trace.txt`, `trace-previous.txt`; the File tab's files in `Documents`.

**Keychain:** generic password, service `com.continuum.signer.certificate-password`,
account = the certificate's UUID.

**Names in use:** notifications `.signThisApp` and `.filesChanged`
(`Views/FilesView.swift:192-195`); background task `com.continuum.signer.refresh`;
URL scheme `signer`; shortcut intents Sign, Install, Check sources, Updates waiting.

---

## A. App screens (`App/Signer/Views/`)

### A1 · High · in the code — "Sign this app" may switch tab without opening Sign
`LibraryView.swift:63-68` is the only listener for `.signThisApp`; `FilesView.swift:183`
posts it. The app starts on the File tab (`SignerApp.swift:27`), so on a cold launch the
My apps view does not exist yet and nothing is listening. The tab changes; the Sign screen
probably does not open. Fix: keep the pending app in `Store` (a `pendingSign: UUID?`) and
have `LibraryView` act on it in `.task`/`.onAppear` as well as `.onReceive`.

### A2 · High · in the code — big IPAs freeze the screen
Zip and file work runs on the main thread in six places:
`SignView.swift:388` (copying the picked file in 4 MB chunks, `Intake.swift:51-79`),
`SignView.swift:404` (`IPAInfo.read`, which can unpack a 64 MB `Assets.car`,
`IPAInfo.swift:70-75`), `FilesView.swift:181` (`importIPA` from the File tab),
`InstallView.swift:149` (`IPAInfo.read` just to get an icon, when `app.iconURL` already
exists), and `SigningRunner.swift:56, 60, 77` plus `:118` — twice more per signing run and
once per import. Fix: move each to `Task.detached`, and use `app.iconURL` in `InstallView`.

### A3 · High · in the code — deleting add-ons removes the wrong ones
`SignView.swift:147`: `.onDelete { idx in idx.forEach { tweaks.remove(at: $0) } }` walks
ascending indexes while the array shrinks. Two deletions take the wrong files. Fix:
`tweaks.remove(atOffsets: idx)`.

### A4 · Medium · in the code — removal toggles on frameworks and extensions do nothing
`InsideAppView.swift:96-112` offers a "remove this library" toggle for links in *every*
program, but `Modifier.removeLibraries` (`Modifier.swift:213-231`) only touches the main
executable, and extensions only when `injectIntoExtensions` is on — which the UI never
sets. Fix: either apply removals to every program, or show the toggle only where it works.

### A5 · Medium · in the code — "install on this phone" silently uses the helper
`InstallView.swift:151-154`: with the on-phone switch on but no `.p12`, `start()` quietly
falls back to `Route.helper`, while the same screen says "Nothing is uploaded anywhere"
(`:129-131`). Fix: say so, and offer to pick a certificate instead of falling back.

### A6 · Medium · in the code — the on-phone host can never be set
`InstallView.swift:169` reads `localHTTPSHost`; nothing in the repo ever writes it. It is
always `127.0.0.1`. Fix: a field in Settings, or drop the setting.

### A7 · Medium · in the code — a common entitlement added by hand can become invisible
`EntitlementsView.swift:161` renders a toggle only for values stored as `.on`, and
`:154-157` hides hand-added entries whose key is one of the five common ones. Add
`get-task-allow` by hand with an "off" or text value and it appears in neither section —
yet it is still applied when signing. Fix: show hand-added common keys in "Added by hand".

### A8 · Medium · in the code — the Sign screen mixes the input and the output
`SignView.swift:260` shows "Inside the app" for the *signed output* once a run finishes,
but signing again uses the *input* (`:430`), and `AppFilesView` is always given the input
(`:275`). A library removed from the output's list is not removed on the next run. Fix:
pick one — the input, always — and say which file is being shown.

### A9 · Medium · in the code — "Install it now" guesses
`SignView.swift:354-356` installs `store.library.first` if it is signed, rather than the
app that was just signed. Fix: use `runner.finished` to find the entry.

### A10 · Medium · in the code — every `.plist` is offered as a pairing file
`FilesView.swift:216`: `.plist`, `.mobiledevicepairing` and `.pairing` all count as
pairing. Any `Info.plist` gets "Use as the pairing file", and its viewer then says "If it
is a pairing file, Signer could not read it" (`:374`). Fix: try `PairingFile(data:)` before
offering the action.

### A11 · Medium · suspected — swipe-to-delete on Sources may not work
`SourcesView.swift:24-53` puts `.onDelete` on a `ForEach` whose rows are each their own
`Section`. SwiftUI often does not offer a swipe there, and there is no other way to delete
a source. Fix: a context menu, or one Section for all rows.

### A12 · Medium · in the code — the certificate check can crash and never clears its banner
`CertificatesView.swift:81-99` iterates `store.certificates.indices` across `await`s and
writes back by index; deleting a certificate during the check can index out of range. The
banner set at `:68-76` has no timer, so it stays for good. `CertificateDetailView` holds a
copy (`:156`), so it never shows an updated result. Fix: snapshot by ID, add a timer, make
the detail view look the certificate up live.

### A13 · Medium · in the code — no confirmation on destructive buttons
"Delete every app in My apps" (`SettingsView.swift:203`), a file's Delete in the File tab
(`FilesView.swift:120`) and "Remove" on a certificate (`CertificatesView.swift:196`) all
act immediately. The codebase already uses `confirmationDialog` elsewhere.

### A14 · Medium · in the code — the web-certificate password is lost easily and stored plainly
`SettingsView.swift:74-75` saves it only when Return is pressed, into `UserDefaults` in
plain text. Certificate passwords go to the Keychain (`SecretStore`). The certificate row
also never refreshes after picking a file (`:72`, `:222-224`, and the write is `try?` with
no feedback).

### A15 · Low · in the code — a non-dictionary plist saved as text stops being a plist
`AppFilesView.swift:375-378`: in text-fallback mode Save writes raw text, so a binary plist
that is an array or a string comes back as plain text and the app may then refuse to open.

### A16 · Low · in the code — folders cannot be marked for deletion
`AppFilesView.swift:117-126` gives the context menu to files only, so `.framework` folders
cannot be removed.

### A17 · Low · suspected — a failed read hides the whole file list
`AppFilesView.swift:45-50, 202`: an error replaces the list with the message, and only
leaving the screen clears it.

### A18 · Low · in the code — dead code
`SourcesView.message` and its alert (`SourcesView.swift:11`, `:96-98`);
`LibraryView.banner` and its overlay (`LibraryView.swift:16`, `:49-61`);
`LibraryView.friendly(_:)` (`:175-177`).

### A19 · Low · in the code — banners do not restart their timers
Replacing one banner with another keeps the first one's timer: `SourcesView.swift:90`,
`HeadersView.swift:123`, `LibraryView.swift`'s pattern.

### A20 · Low · in the code / suspected — smaller screen issues
- The port field shows "62,078" because `.number` uses the locale separator
  (`SettingsView.swift:106`).
- The trace picker jumps back to "the run before" when the last file is missing
  (`TraceView.swift:79`).
- "stopped: …" is not shown in red in `TraceView` although Settings treats it as bad
  (`SettingsView.swift:232`).
- The certificate picker can show nothing selected while a certificate is in use
  (`SignView.swift:313-315` vs `Store.swift:81-83`).
- `.deb` add-ons are refused (`SignView.swift:153`); see S19.
- Add-ons imported with the + button go to `Tweaks/` (`Intake.swift:143-147`), which the
  Sign screen never lists — its list only holds `.dylib`s it copied into `Documents`
  (`SignView.swift:396-400`).
- The Details help text says the app keeps its ID while the button next to it replaces the
  ID (`SignView.swift:113-119`).
- The header file is overwritten without asking (`HeadersView`, per the read-through).
- "HEX Editor" only views (`FilesView.swift:119`, `:387-410`).
- The File tab's `detail` line shows time of day with no date (`FilesView.swift:221-229`).
- The pairing-file row does not update after import (`SettingsView.swift:95-98`), nor does
  the pairing section inside an open install sheet (`InstallView.swift:71`).
- The install sheet's main button does not check `device.busy`, so both install roads can
  run at once (`InstallView.swift:39`).
- The signed-apps-with-an-update row shows "Update" instead of "Install"; Install is only
  in the context menu (`LibraryView.swift:229-237`).
- `onChange(of:) { x in }` single-value closures in `SettingsView.swift:170` and
  `TraceView.swift` are deprecated from iOS 17 (warnings only).

---

## B. App models, entry point, Info.plist (`App/Signer/Model/`, `App/Signer/`)

### B1 · High · in the code — plain `http://` is blocked by App Transport Security
`App/Signer/Info.plist:60-67` sets `NSAllowsLocalNetworking` **and**
`NSAllowsArbitraryLoads`. From iOS 10 on, Apple ignores `NSAllowsArbitraryLoads` when
`NSAllowsLocalNetworking` is present, so `http://` sources and downloads fail. Apple's own
documentation says so. Fix: drop `NSAllowsLocalNetworking`, or add per-domain exceptions
for the hosts that need plain HTTP (`NSExceptionDomains`).

### B2 · Medium · in the code — notification permission is never asked for
`BackgroundRefresh.swift:46-49` asks only when the Settings toggle changes
(`SettingsView.swift:172`), but the toggle defaults to on, so the question never appears
and the notifications never show. Fix: ask on first background check, or on first launch
after the switch has been seen on.

### B3 · Medium · in the code — update notices repeat and double-count
`BackgroundRefresh.swift:57-58` re-notifies every run for the same apps, and `:65-74`
counts duplicate library entries twice. `SignerIntents.swift:109, 132` has the same
counting. Fix: remember what was announced.

### B4 · Medium · in the code — source details are never written back
`SourceFeed.swift:180-208` never sets `Source.lastRefreshed`, `appCount`, `name` or
`iconURL` (`Models.swift:157-158`), so the Sources screen can only show "N apps" from
memory and loses it on relaunch.

### B5 · Medium · in the code — update offers live only in memory
`SourceFeed.swift:147-153`: `offers` is rebuilt from `feeds`, which is never saved, so
`UpdatesWaitingIntent` and a fresh background launch report nothing until a refresh has
finished. Fix: persist offers, or refresh before answering.

### B6 · Medium · suspected — a Sign shortcut can be lost on a cold launch
`SignerIntents.swift:64` posts `.signThisApp`; nothing is listening yet, and
`LibraryView.swift:63-67` then falls back to the first app. Same root cause as A1.

### B7 · Medium · in the code — a failed add-on check leaves a junk `.ipa`
`SigningRunner.swift:55-73` throws after the output is written and the trace has closed
(`:104`), so `Apps/signed-*.ipa` stays behind with no library entry.

### B8 · Medium · in the code — two signing jobs can run at once
There is no global guard: `SigningRunner.run` (`:13-37`), `Updates.run`
(`Updates.swift:23`) and each `SignView`'s own `@StateObject runner` (`SignView.swift:11`)
can all be going at the same time. The shared trace file and the Live Activity get
clobbered. Fix: one shared job slot.

### B9 · Medium · in the code — progress can be overwritten out of order
`SigningRunner.swift:42-48` starts a new main-actor `Task` for every progress callback;
ordering is not guaranteed, so a late "Signing X" can land after "Signed".

### B10 · Medium · in the code — the keep-awake expiry handler stops the sound that keeps the job alive
`KeepAwake.swift:21-23` calls `endNow()` when iOS expires the background task, and
`endNow` (`:51-61`) stops the audio. The silent loop exists precisely to hold the job open.

### B11 · Medium · in the code — downloads are not kept alive, and the progress is fake
`SourceFeed.swift:215-245` uses a plain `URLSession.shared` with no background session and
no `KeepAwake`, and steps the bar on its own. Locking the screen can lose a big download.

### B12 · Medium · in the code — a same-named file is silently replaced
`Intake.swift:52, 60`: `keep` writes into `Documents` and overwrites an existing file of
the same name, which a library entry may be pointing at.

### B13 · Medium · in the code — importing a `.framework` folder fails
`Intake.swift:29, 56` opens the import with `FileHandle`, which a directory does not
support.

### B14 · Medium · in the code — updating deletes the old copy before the install happened
`Updates.swift:52-63`: `deleteApp(old)` runs when the new entry is added; the install is
only a sheet (`pendingInstall`). Cancel the install and both copies are gone. It also
carries only `compressOutput` and `adhoc` from the user's Sign options, dropping name, ID
and add-on choices.

### B15 · Medium · in the code — a false "add-on" warning
`IPAInfo.swift:52-54, 145-147`: `linkedTweaks` counts every `@rpath` and framework dylib,
so ordinary apps get warnings about add-ons they do not have.

### B16 · Low · in the code — fat binaries past the first 256 KB are missed
`IPAInfo.swift:48` reads only the start of the file when looking at slices.

### B17 · Low · in the code — two files with one name share an icon
`SigningRunner.swift:120, 128` writes `Apps/<name>.png`; two files with the same base name
in different folders collide, and `IconCache.swift:22-37` never invalidates.

### B18 · Low · in the code — other import edges
- `Intake.swift:139-142`: several password-protected `.p12`s at once — only the last gets
  a prompt.
- `DocumentPicker.swift:19-20` + `Intake.swift:51`: the picker's `Inbox` copy is never
  deleted, so a big app costs twice the space.
- `Intake.swift:42-43`: profile sniffing looks for text in the first 4 KB of a CMS-wrapped
  file and can miss.
- `Store.swift:196-199`: the legacy plain-JSON password is never cleared after the move to
  the Keychain.
- `Store.swift:78`: `state.json` is written non-atomically and errors are swallowed;
  `:70` cleans duplicates in memory without saving.
- `Store.swift:140-143`: a duplicate profile import does not re-pair it to certificates.

### B19 · Low · in the code — Live Activity leftovers
`SigningIsland.swift:35, 52, 69` use APIs deprecated from iOS 16.2, and an Activity left
behind by a killed job is never ended. Warnings only for the first part.

### B20 · Low · suspected — the Shortcuts initializer may not compile as written
`SignerIntents.swift:152-169` relies on the iOS 16 `AppIntent` initializer that takes
optionals. It is built in CI, so it probably compiles; recorded because it was questioned.

### B21 · Low · in the code — `signer://` does nothing
`Info.plist:68-78` declares the scheme; `SignerApp.swift:86` drops every non-file URL.

### B22 · Low · in the code — over-broad file claims
`Info.plist:149-151, 164, 177`: the "Certificate" document type claims `public.data` (every
file on the phone), and `dylib` is declared under the `deb` type. `:46` declares the
`processing` background mode with no `BGProcessingTask` registered.

### B23 · Low · in the code — wrong or stale comments
`SecretStore.swift:6` (what a locked phone does), `BackgroundRefresh.swift:10` ("once a
day" vs 6 hours at `:40`), `KeepAwake`'s reason for the silent loop.

### B24 · Low · in the code — expiry rounding
`Models.swift:62-65, 104-107`: `daysLeft` is `Int(interval / 86400)`, which truncates toward
zero, so a certificate that expired less than a day ago reports `0` days rather than a
negative number — it reads as "expires today", not "expired". Fix: `floor` toward negative
infinity for the past.

### B25 · Note · in the code — the builds carry no entitlements
`project.yml:36, 61` build with `CODE_SIGNING_ALLOWED: NO`. Whoever re-signs Signer must
supply entitlements for the app *and* the Dynamic Island extension, or the extension is
rejected.

---

## C. Installing (`App/Signer/Install/`, `SignKit/Install/`, `SignKit/Certs/`)

### C1 · High · needs a device + external check — the AFC file-open answer is read with the wrong operation code
`LockdownWire.swift:149-151`: `Answer.handle` requires operation 2 (`data`). Real devices
answer `AFC_OP_FILE_OPEN_RES = 0x0E` (14) — libimobiledevice's `afc.h` and `afc.c` show
it. `AFC.Operation` (`:85-94`) has no case for 14, so `opened.handle` is always nil and
`DeviceInstaller.swift:193-195` always fails with "iOS would not let a file be written…".
The unit test builds the same wrong op 2 itself (`PairingTests.swift:116`), so it cannot
catch this. **Fix the check, and the test, to 14.**

### C2 · High · in the code — `Range: bytes=-0` traps
`InstallServer.swift:295-297`: `start = total`, then `start...(total - 1)` makes a
`ClosedRange` with its lower bound above its upper bound, which traps. Any local client can
send that header. Fix: `guard suffix > 0`.

### C3 · High · suspected — SIGPIPE can kill the app
`LockdownClient.swift:50-57, 88, 134` use BSD sockets with no `SO_NOSIGPIPE` (or
`MSG_NOSIGNAL` on send). If the phone closes while Signer is writing, the default SIGPIPE
terminates the process.

### C4 · High · suspected — errors and timeouts under TLS spin forever
`LockdownClient.swift:119-121, 137-139` turn every recv/send error and timeout into
`errSSLWouldBlock`; callers `continue` forever (`:171-172`, `:195-197`, `:212, :222, :232,
:250`). A dead connection hangs and burns CPU instead of failing. Fix: count retries and
give up with a message.

### C5 · High · suspected — a silent phone looks like a closed connection
Without TLS the sockets set a 10 s `SO_RCVTIMEO` (`LockdownClient.swift:53-57, 100`), and
`installation_proxy` can be quiet for much longer than that while iOS installs a big app,
so a good install reports "iOS closed the connection".

### C6 · High · suspected — a stale Keychain item can block pairing for good
`LockdownClient.swift:298-299` ignores the `SecItemAdd` status. A crash before cleanup
leaves the certificate row behind; the next add returns `errSecDuplicateItem`, the label
lookup fails, and every attempt says "iOS would not pair the certificate with its key" with
no way out. Fix: check the status, delete first, and offer a reset.

### C7 · Medium · in the code — a PKCS#8 host key will not load
`Pairing.swift:84, 92-97` returns whatever PEM block matches "PRIVATE KEY", so a PKCS#8
`BEGIN PRIVATE KEY` reaches `SecKeyCreateWithData` (`LockdownClient.swift:283`), which
wants PKCS#1. A common pairing-file shape.

### C8 · Medium · suspected — the UDID reader can miss the answer
`UDIDReader.swift:96-97` stops the listener right after sending; nothing keeps the app
alive while the person is in Settings installing the profile (no `KeepAwake`, unlike the
installers), so iOS may POST to a suspended app. Many Profile Service servers answer 301
rather than 200; whether iOS accepts our 200 is unverified.

### C9 · Medium · in the code — a failed UDID listener is invisible
`UDIDReader.swift:31-37` has no ready/failed handler. If port 14302 is busy, nothing is
shown and `isWaiting` stays true forever.

### C10 · Medium · suspected — the first finished range request ends the install
`InstallServer.swift:249-256` sets `.handedOff` and calls `stop()` (`:97`), which cancels
**every** open connection. If iOS fetches ranges in parallel, the others are dropped. The
early-exit path (`:213-217`) also ends `KeepAwake` without resetting `keepingAwake`, and
`KeepAwake` has one shared counter (`KeepAwake.swift:45-49`), so another job's keep-awake
can end early too.

### C11 · Medium · suspected — only one read per request
`InstallServer.swift:172` does a single `receive` of up to 8 KB. A request split across TCP
segments loses its `Range` header, and the connection stays in `connections` until `stop()`.

### C12 · High · in the code — the phone's TLS certificate is never checked
`LockdownClient.swift:161, 173-174`: `breakOnServerAuth` is set and then continued past,
while the doc comment (`:10-12`) claims a check. `PairingFile.deviceCertificateDER`
(`Pairing.swift:85-87`) is never used. What makes it acceptable is that holding the pairing
file is the proof — say that in the comment instead.

### C13 · High · in the code — both listeners answer on every network interface
`InstallServer.swift:121-124` and `UDIDReader.swift:29-32` set no loopback-only
requirement. Anyone on the same Wi-Fi can download the signed `.ipa`, or POST a UDID before
the real phone does. `NSLocalNetworkUsageDescription` is also absent from `Info.plist`.
Fix: `params.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: …)`.

### C14 · Medium · in the code — OCSP answers are not authenticated
`OCSP.swift:46-94` checks neither the responder signature, nor the CertID, nor a nonce, and
goes over plain HTTP. On-path tampering can say "good" or "revoked". The `caIssuers`
download (`:122-126`) is accepted on a name match alone.

### C15 · Medium · in the code — no integrity checks on `.p12` files or profiles
`PKCS12.swift:15-103` never verifies the MAC; `Profile.swift:9-33` never verifies the CMS
signature. A damaged or tampered file is read as if it were fine.

### C16 · Medium · in the code — `api.palera.in` sees every install
`InstallServer.swift:14, 345-368`: the default helper learns the bundle ID, name, version
and the URL iOS will fetch. Worth saying plainly in the app's own words, and worth offering
the on-phone route first.

### C17 · Medium · in the code — an expired certificate is reported as "revoked"
`OCSP.swift:138-141`. `CertificatesView` compensates (`:84-99`), but the engine's own
answer is wrong.

### C18 · Medium · in the code — PKCS#12 parsing edges
`PKCS12.swift:162-163` falls back to SHA-1 for HMAC-SHA384/512 PBES2 (a wrong-password
error is what the person sees); `:77` aborts the whole file on a non-RSA shrouded key bag;
`:98`'s `?? certs.first` can pick a certificate that does not match the key.

### C19 · Low · in the code — the empty-password edge
`KDF.swift:12` always appends the null terminator (`|| true`), so a file that encoded an
empty password with zero length will not decrypt.

### C20 · Low · suspected — install options that are not what tools send
`LockdownWire.swift:59` sends `PackageType: "Developer"` for a zipped `.ipa` (tools use
that for an unpacked `.app`); `startSession` (`:48`) sends no `ProtocolVersion`; uploaded
`PublicStaging/signer-*.ipa` files are never removed from the phone.

### C21 · Low · suspected — the default lockdown host is probably wrong
`DeviceInstaller.swift:27` defaults to `127.0.0.1`; tunnel apps usually expose the device
elsewhere (SideStore's tunnel is commonly `10.7.0.1`). Unverified for this app.

### C22 · Low · in the code — the wrong pairing file cannot be noticed
`Pairing.swift:76-79`: `isFor(udid:)` is never called, and it returns true when the file has
no UDID.

### C23 · Low · in the code — chain checks that are weaker than they look
`AppleChain.swift:42` returns the only name match without a key check; `X509.swift:98-102`
`isSigned(by:)` is RSA-only, so the EC-signed links (G2/G6) cannot be verified at all.

### C24 · Low · in the code — date and name parsing limits
`DER.swift:115` rejects fractional `GeneralizedTime`; `X509.swift:45-55` loses repeated
attributes, so two OUs show as one.

### C25 · Low · in the code — leftovers and dead branches
`LockdownClient.swift:21, :256`: `Failure.refused` and `takeLeftovers()` are unused.
`InstallServer.swift:2, :339-341`: the `#else` in `tlsParameters` can never run because
`Network` is imported unconditionally.

### C26 · Low · in the code — SecureTransport is deprecated
`LockdownClient.swift:150-179` builds TLS with `SSLCreateContext` and friends, deprecated
since iOS 13, and it caps at TLS 1.2. It still works; a `NWProtocolTLS` rewrite is the way
out, but the half-cleartext start is exactly why plain sockets were chosen
(`docs/DECISIONS.md`, 27 October).

### C27 · Note — what is untested
Tested without a phone: wire framing, AFC packet shapes, pairing-file parsing
(`PairingTests`); OCSP parse and request shape (`OCSPTests`); the 8 built-in Apple
certificates and chain building (`AppleFormatTests.swift:116-163`); PKCS#12 with the
fixtures (`PKCS12Tests`).
**Not tested at all:** `InstallServer`, `LockdownClient`'s TLS and sockets,
`DeviceInstaller` against a real phone, `UDIDReader`, `KeychainTLS`, and the real
certificate OCSP tests (skipped — their fixture paths are hard-coded).

---

## D. The signing engine (`SignKit/Signing/`)

### D1 · High · in the code — a load command can disagree with where the signature goes
`MachOSigner.swift:81-95`: the load command's `dataoff` is written as
`align(codeLimit, 16)` (`:86`), but if the slice has bytes past `__LINKEDIT` the signature
offset is moved to `data.count` (`:94`) without updating the command. The signature then
sits where the command does not point, and the code directory covers the wrong range.

### D2 · Medium · in the code — the two signing routes can produce different bytes
`MachOFileSigner.swift:76, 83` computes `codeLimit` from the file size or the old signature
offset, rounded up to 16; `MachOSigner.swift:73` uses the end of `__LINKEDIT`. The comment
at `MachOFileSigner.swift:90-92` says they match. The trial run also hashes a different
`codeLimit` from the final one (`MachOSigner.swift:122` vs `:103`).

### D3 · Medium · in the code — `BinaryReport.SignatureFacts.hasProfile` means nothing
`BinaryReport.swift:129` sets it from the DER-entitlements slot, which has nothing to do
with a profile being present.

### D4 · Low · in the code — dead plumbing
`nestedCDHashes` is accepted and passed along (`CodeResources.swift:46-47, 189-191`;
`BundleSigner.swift:85`) and never used — the comment at `:65-67` says plain hashes are
deliberate.

### D5 · Medium · in the code — `removeFiles` has no path-traversal check
`Modifier.swift:21-23` deletes `app + rel` with no `../` guard, unlike `replaceFiles`
(`:30-33`). A crafted name could delete files outside the app. Fix: reuse the same
`standardized` prefix check.

### D6 · Medium · in the code — entitlements are dropped silently
`MachOSigner.swift:148` and `MachOFileSigner.swift:226` discard `Entitlements.storable
(...).kept`, so a Data or Date value from a profile disappears with no warning.

### D7 · Medium · in the code — `extraEntitlements` are ignored in ad-hoc mode
`BundleSigner.swift:95` passes `nil`, with no warning shown.

### D8 · Medium · in the code — the inspector never stops a run
`IPASigner.swift:136-138`: a broken app is still zipped and returned; the problems appear
only as warnings. That is a deliberate choice (the person can still install and see), but
it means "Check failed" never prevents anything.

### D9 · Medium · in the code — a missing code directory returns a fake cdhash
`MachOFileSigner.swift:157` hashes empty data and returns it rather than throwing.

### D10 · Medium · in the code — the junk sweep is too greedy
`Modifier.swift:45-46` deletes any file named `CodeResources` at any depth, even outside
`_CodeSignature`.

### D11 · Medium · in the code — fat binaries are loaded whole
`MachOFileSigner.swift:60` and `Modifier.swift:258` read the entire file into memory
whatever its size, so a large universal binary can get the app killed. The returned cdhash
covers slice 0 only (`:66-67`). `MachOFile.encoded()` always writes a 32-bit fat header
(`MachO.swift:277`), even for a fat64 input.

### D12 · Medium · in the code — binaries of 4 GB or more crash
`UInt32(codeLimit)` in `Blobs.swift:135`, `MachOFileSigner.swift:99-100` and
`MachOSigner.swift:86-87` traps above 4 GB, and `codeLimit64` (`Blobs.swift:144`) is never
written.

### D13 · Medium · in the code — huge binaries are mostly processed twice
`MachOFileSigner.swift:93-141`: the first-pass estimate is generous, so `tight != reserve`
is almost always true and each multi-GB binary is copied and hashed again. Progress jumps
back to 0 on each retry.

### D14 · Low · in the code — free header space is judged from a 64 KB head
`MachOFileSigner.swift:71-73` cannot see a header larger than 64 KB, which then fails with
"not enough free space in the app's header".

### D15 · Medium · in the code — Watch apps
`BundleSigner.swift:57-71, 78-80` signs a nested watch `.app` with the iOS profile and
entitlements and says nothing; `_WatchKitStub` is skipped by the signer (`:160`) but hashed
into `CodeResources`, and `SignatureInspector.swift:49-61` does not skip it either, so the
stub keeps its old signature. `removeWatchApp` does not remove a watch extension that sits
in `PlugIns/`.

### D16 · Medium · in the code — App Clips are not handled anywhere
`Modifier.swift:158` does not move `AppClips/` to a new ID, and `hasExtensions` /
`removeExtensions` do not see them, so changing the ID leaves the clip under the old
prefix. `AppClips` does not appear in the repo at all.

### D17 · Medium · in the code — architecture thinning and minimum iOS only reach executables
`Modifier.swift:213-224` touches the main executable and extension executables, not
frameworks or dylibs; `injectIntoExtensions` ignores `Extensions/` (`:215`).

### D18 · Low · in the code — Liquid Glass is only half done
`Modifier.swift:83` sets the Info.plist key; `MachOSlice.setSDK` (`MachOEdit.swift:92`) is
never called, and it ignores `LC_VERSION_MIN` anyway (`:94`).

### D19 · Low · in the code — `.deb` tweaks are not unpacked
`Modifier.swift:192-198` says so, and the Sign screen says so too (`SignView.swift:153`).

### D20 · Low · in the code — the new icon is one PNG under four names
`Modifier.swift:134-136` writes the same image for every icon filename and produces no
1024-px or Settings/Spotlight size (see also `AssetCatalog.png(for:in:)` returning JPEG
bytes unchanged for `.jpeg`, `AssetCatalog.swift:275-276`).

### D21 · Low · in the code — a bundle with no `Info.plist` fails the whole run
`BundleSigner.swift:31-37` throws for `.xpc`, `.xctest` and `.systemextension` bundles,
which legitimately have neither.

### D22 · Low · in the code — profiles are embedded in places that do not want one
`BundleSigner.swift:78` writes `embedded.mobileprovision` into `.xpc`, `.xctest` and
`.systemextension` bundles too.

### D23 · Low · in the code — relative paths are fragile
`CodeResources.swift:56` builds names with `replacingOccurrences(of: bundle.path + "/")`,
and other places drop a `standardizedFileURL` prefix. If the walker returns
`/private/var/…` while the bundle URL is `/var/…`, names come out wrong.

### D24 · Low · in the code — one rule does not match Apple's
`CodeResources.swift:74` skips `locversion.plist` at any depth; Apple's rule omits it only
under `.lproj/` (`:31`).

### D25 · Low · in the code — weak spots in the inspector
`SignatureInspector.swift:319-323` silently skips RSA verification when the key does not
parse; `:75` matches the profile against the first binary's certificate only; `:55` walks
into `.dSYM` folders instead of skipping them.

### D26 · Medium · in the code — encrypted App Store apps are not refused by the engine
Only the app layer warns (`IPAInfo.swift:141`). A signed-then-installed FairPlay app fails
on the phone with no word from the engine.

### D27 · Low · unverified — SHA-1 only
`hashKind = .sha1` produces a SHA-1-only directory and CMS, with no SHA-256 alternate.
Whether current iOS accepts that has not been tried.

### D28 · Medium · in the code — no progress from nested bundles, and no cancel at all
`BundleSigner.swift:51` reports nothing while nested bundles sign, so a framework-heavy app
looks stuck. SignKit has no cancellation path, so "Stop" does not exist.

### D29 · Low · in the code — unused leftovers
`BundleSigner.write(_:to:)` (`:127-130`), `var options = options` (`IPASigner.swift:87`),
`CSFlags.runtime`, `CSFlags.linkerSigned`.

---

## E. Mach-O, zip, crypto, utilities, CLI

### E1 · High · in the code — `replaceDylib` reorders linked libraries
`MachOEdit.swift:61-70` removes the old load command and appends the new one at the end,
renumbering every library after it. Imports are bound by ordinal, so symbols can end up
pointing at the wrong library and the app crashes at launch. This is the
CydiaSubstrate → ElleKit swap (`Modifier.swift:236, 274`). `removeDylib` (`:48`) renumbers
the same way, which is why D5/A4 removals need care. Fix: replace the name in place when
it fits, otherwise rebuild every command after it without moving them.

### E2 · High · in the code — the streaming unzip can loop forever
`ZipStream.swift:76-77`: once `inflate` has returned `Z_STREAM_END` with input left over,
`produced == 0 && status != END` never breaks and `avail_in > 0` keeps the loop going.

### E3 · High · in the code — symlink escape when unpacking
`Zip.swift:216, 235-240` does not check symlink targets, so a later entry can write through
a symlinked folder to outside the target directory. In the same line, the `..` check
rejects legitimate names like `a..b.png`, so some real apps fail to unpack. Fix: check the
resolved path stays under `dir`, and check path *components* for `..`.

### E4 · Medium · in the code — RSA verification is lenient
`RSA.swift:97-106`, used for chain checks at `X509.swift:104`: it checks only that the
recovered block starts `0x00 0x01` and contains a `0x00` separator, then parses the DER
after it. The padding bytes between are never tested for `0xFF`, the digest algorithm in
the DER is not compared with the OID it should be, and bytes after the DER are ignored. It
does compare the digest itself, which is the part that matters most. With Apple's 65537
exponent this is not practically forgeable, but it is the weakest check in the engine.
Fix: require at least 8 `0xFF` bytes, match the OID, and require exact length.

### E5 · Medium · in the code — class-dump only understands one chained-fixup pointer format
`ObjCDump.swift:370-376` handles format 6. On arm64e, bit 63 means "authenticated", so
authenticated rebases are dropped (`:417`); `DYLD_CHAINED_PTR_64` (format 2) yields
addresses where a target is expected, so names come out nil. `usesChainedFixups`
(`:319, :330`) is computed and never used.

### E6 · Medium · in the code — import format 3 name offsets are wrong
`ObjCDump.swift:448-464`: `DYLD_CHAINED_IMPORT_ADDEND64` keeps the name offset in the
second 32-bit word, not `word >> 9`. Compressed symbol pools (`symbols_format`) are
ignored.

### E7 · Medium · in the code — the class-dump name cache can cross programs
`ObjCDump.swift:480-481` keys the cache by `cpuType-dataCount`, so two programs of the same
CPU and size share names. It is never cleared.

### E8 · High · in the code — malformed input crashes instead of throwing
The `Data` readers in `Bytes.swift:29-46` do not bounds-check and are used on unchecked
offsets: `MachO.swift:69-80` (`loadCommands` not limited to `sizeofcmds`), `:159` (the
section loop in `headerPadding`), `:134-135, :141-142` (`nameOff > size` gives a negative
length), `:219-223` (the fat arch table); `Zip.swift:86, :92` (central-directory name and
extra); `Bytes.swift:83` (`find(from:)`); `RC2.swift:31` (key over 128 bytes);
`DER.swift:35-39` (BER recursion with no depth limit). A hostile `.ipa` is a crash; on a
phone that is the app dying mid-sign.

### E9 · Medium · in the code — fat files over 4 GB crash on re-encode
`MachO.swift:274-290` always writes a 32-bit fat header, so `UInt32(offset/size)` traps
above 4 GB and a fat64 input comes out as fat32.

### E10 · Medium · in the code — ZIP64 edge cases in `addFile`
`Zip.swift:388`: `UInt32(written)` traps if incompressible data just under `0xFFFF0000`
grows past 4 GB when deflated. `add()` (`:284-320`) writes no local zip64 extra and always
puts both sizes into the central one.

### E11 · Medium · in the code — unzip trusts the zip
`Zip.swift:169-179, 573` do not check CRC or length, so damaged data comes back truncated
and reported as fine; `:554`'s `reserveCapacity(expected)` trusts the claimed size, which a
crafted file can use for a huge allocation; `head(of:)` (`:153`) swallows zlib errors.

### E12 · Medium · in the code — writes that can crash on a full disk
`Trace.swift:183` (`h.write(data)`) and `ZipStream.swift:24, 51, 98, 125`
(`readData(ofLength:)`) raise Objective-C exceptions on I/O errors, which Swift cannot
catch.

### E13 · Low · in the code — a public `Hasher` shadows Swift's own
`Hash.swift:17` declares `public struct Hasher`. Swift's standard library also has
`Hasher`, and client code that imports SignKit and writes `var h = Hasher()` or
`hash(into:)` can resolve to SignKit's type and fail to compile. Fix: rename to `Digest`.

### E14 · Low · in the code — `addTree` path building
`Zip.swift:453` uses `replacingOccurrences(root.path + "/")`; a `/private/var` vs `/var`
mismatch produces absolute entry names.

### E15 · Low · in the code — BigInt speed and side channels
`BigInt.swift:150-161, 174, 225, 228, 261`: divides go bit by bit, `rr` is recomputed on
every `powMod` call, and each multiply copies the modulus. Nothing is constant time
(`:262, :272`) and there is no blinding. Fine for a few RSA operations per app; slow for
anything bigger.

### E16 · Low · in the code — version comparison
`Version.swift:29-30, 57`: suffixes compare as plain text (`beta10 < beta2`), and `+build`
counts as a pre-release.

### E17 · Low · in the code — smaller items
- `KDF.swift:12`: leftover `|| true`.
- `Ciphers.swift:15`: a malformed file is reported as a wrong password.
- `MachOEdit.swift:97`: comment says it returns the slice; it returns nothing.
- `MachOEdit.swift:113`: `max(vmsize, 0)` does nothing.
- `MachOEdit.swift:129`: `thin` silently does nothing.
- `MachO.swift:8`: `LC.idDylib` is never used.
- `ObjCDump.swift:122, 156`: the `seen` parameter is unused.
- `ObjCDump.swift:261-266`: `@optional` and protocol properties are not marked.
- `ObjCDump.swift:272`: `unmangle` does not handle nested Swift names.
- `DER.swift:70`: the first OID arc is wrong once an arc encodes to 80 or more.
- `DER.swift:98`: `intValue` sign and overflow.
- `DER.swift:231`: `encodeOID` can trap.
- `DER.swift:13`: `children` re-parses on every access.
- `ZipStream.swift:90`: `deflate` ignores its `size` argument.
- `Zip.swift:75`: `eocd = loc` is never used.
- `Trace.swift:35-38`: comment says "plain load" but it takes a lock.
- `Trace.swift:52`: a file with no extension gets a `-previous.` name with a trailing dot.
- `Trace.swift:173`: the Linux memory figure assumes 4 KB pages.
- `signkit-cli/main.swift:84-92`: `args[i + 1]` is not bounds-checked.
- `signkit-cli/main.swift:10`: the usage text omits `--inject` (`:75`).
- `ShareCode.swift:102`: falls back silently when the key fails to decode.

---

## F. Tests and tools

### F1 · High · in the code — a test starts failing on 27 December 2026
`CryptoTests.swift:72`: `XCTAssertGreaterThan(cert.daysLeft ?? 0, 300)` against
`testkey.crt`, which ends 2027-10-24 21:55:09Z. From about **2026-12-27 22:00 UTC** it
fails, and CI goes red. `:67` (`isExpired`) fails after 24 October 2027. Fix: pin the
certificate's own end date instead of a countdown, or generate the fixture in the test.

### F2 · High · in the code — the stand-in certificate and profile expire 7 March 2027
`standin.mobileprovision` is valid to 2027-03-07T12:05Z and embeds a leaf with the same end
date. From then, `SignatureInspector.swift:335` reports the certificate and `:476` the
profile as `expired`, so `report.isClean` goes false and `IPASignerTests.swift:195`,
`EndToEndTests.swift:55` and `:62` would fail — wherever the sample apps exist, which today
is nowhere in CI. Fix: allow a test identity to say "ignore the dates", or regenerate the
fixtures with a longer life (`tools/make-test-fixtures.py` already can — see F14).

### F3 · High · in the code — nothing in CI signs a real program
All 40 skips come from sample paths under `/projects/sandbox/research/ipa/`:
`Feather.ipa`, `Ksign.ipa`, `SideStore.ipa`, `GBox.ipa` and the unpacked folders beside
them (see the table below). They are not in the repo, so `MachOSigner`,
`MachOFileSigner`, `BundleSigner`, `CodeResources`, `Modifier`, `SignatureInspector`,
`BinaryReport`, `AppContents`, `AssetCatalog.read`, real-profile parsing and
`IPASigner.sign` end to end have **no coverage in CI at all**. Fix: build a tiny Mach-O in a
test (a hand-written 64-bit header with one `__TEXT` segment is enough to exercise the
whole signature path), and check a real `.ipa` in as a small fixture.

| File | Skipped / total |
|---|---|
| IPASignerTests | 7 / 8 |
| SignerTests | 6 / 6 |
| BundleTests | 4 / 4 |
| HugeAppTests | 4 / 4 |
| EndToEndTests | 3 / 6 |
| AppContentsTests | 3 / 4 |
| ZipStreamTests | 2 / 3 |
| OCSPTests | 2 / 6 |
| AssetCatalogTests | 2 / 4 |
| ProfileTests | 2 / 3 |
| BinaryReportTests | 2 / 2 |
| AppleFormatTests | 1 / 14 |
| ZipTests | 1 / 6 |
| ObjCDumpTests | 1 / 6 |
| **Total** | **40 / 126** |

### F4 · Medium · in the code — `LeftoverTests` deletes folders other tests own
`LeftoverTests.swift:17` calls `clearLeftovers()`, which deletes every temp folder starting
`signkit-` (`IPASigner.swift:182`); `ZipTests.tempDir()` uses the same prefix
(`ZipTests.swift:10`), as does every `IPASigner` work folder (`IPASigner.swift:38`). Under
`--parallel` it can wipe another test mid-run. CI runs serially, so it is latent.

### F5 · Medium · in the code — shared global state
`MachOFileSigner.diskThreshold` is a `public static var` changed by `HugeAppTests.swift:65,
119, 159`; `Trace` is global too and `TraceTests` flips it while `IPASigner` writes to it.

### F6 · Low · in the code — one timing-dependent test
`TraceTests.swift:126` expects under 200 lines and depends on the 0.2 s rate limit
(`Trace.swift:18`). A very slow runner writes more lines.

### F7 · Medium · in the code — assertions that cannot fail
`AssetCatalogTests.swift:82`: `XCTAssertNotNil(...map { $0 == "IHDR" })` passes for any
chunk. `BinaryReportTests.swift:55` compares a value with itself.
`AppContentsTests.swift:92`: the `isEmpty ||` is redundant. `BundleTests.swift:168` does not
check the "deepest first" order its name claims; `:80` has an odd `?? [:].keys`.

### F8 · Low · in the code — a test that is named but missing
`EndToEndTests.swift:153-155` says "the next test covers" entitlements the profile does not
grant; the next test does not, and nothing else does.

### F9 · Low · in the code — dead and risky bits in tests
`fixedTime` is unused (`HugeAppTests.swift:56, 107`); page 0 is left out of the disk vs
memory comparison (`:84-89`). Two random 6-character IDs could collide
(`IPASignerTests.swift:331`); `abs(entry.name.hashValue)` traps on `Int.min`
(`ZipStreamTests.swift:62`).

### F10 · Low · in the code — brittle pins
Exactly 8 Apple certificates (`AppleFormatTests.swift:116`), exactly 10 `rules2` entries
(`IPASignerTests.swift:78`, `BundleTests.swift:80`), and sample-dependent rules of thumb
(`ObjCDumpTests.swift:25, 39`).

### F11 · Medium · in the code — clearly untested engine areas
Not covered at all: `OCSP.check` and every async network path (`OCSP.swift:116, 136`);
`MachOEdit` (`removeDylib`, `replaceDylib`, `addRpath`, `setSDK`, `thin`, `archNames`) and
any multi-slice assertion; `MachOFile.isMachO(url:)`, `isSignable(url:)`, `isEncrypted`,
`rpaths`; most `SigningOptions` fields (`buildNumber`, `minimumOS`, `itunesFileSharing`,
`gameMode`, `iPadFullscreen`, `appearance`, `removeURLSchemes`, `removeDeviceRestrictions`,
`liquidGlass`, `removeExtensions`, `removeFiles`, `keepArchitectures`, `injectLibraries`,
`removeLibraries`, `injectIntoExtensions`, `injectPath`, `replaceSubstrateWithEllekit`,
`hashKind = .sha1`); `IPASigner`'s not-enough-space error (`IPASigner.swift:61-66`); ZIP64
read and write (`Zip.swift:66-72, 284-316, 354-408`) — nothing over 4 GB or 65,535 entries
is tried; `KDF.pkcs12` has no known-answer test; `Requirement.emptySet()` and the
SHA-1 + SHA-256 CMS variant; profile `includes(deviceUDID:)`, `isExpired`, `daysLeft`;
X509 `caIssuersURL`, `appleID`, the expired case; `LockdownWire.startSession`'s contents and
`AFC.makeDirectory`; the `.certificate`, `.expired`, `.entitlements`, `.profile` inspector
kinds; `AssetCatalog.png(for:in:)`, `Trace.memoryNow()`; the whole of `signkit-cli` and
everything in `App/`.

### F12 · Medium · in the code — real profiles are barely tested
The stand-in profile is a plain plist, so CMS-signed profile parsing is only exercised by
the sample-gated `ProfileTests` and `OCSPTests`. Fix: commit one real `.mobileprovision`
with an expired team as a fixture (a public one is fine) and parse it in CI.

### F13 · Low · in the code — the outside check ignores a failure
`tools/verify-signature.sh:45` puts `rcodesign verify` inside a `cmd && echo` list, so under
`set -e` its failure is ignored and the script still prints "OK".

### F14 · Note — the tools
- `tools/make-icon.py` (117 lines, standard library) draws the 1024×1024 icon by hand and
  writes the appiconset plus both `Contents.json` files. No arguments.
- `tools/make-test-fixtures.py` (89 lines) needs `cryptography` and a folder holding
  `AppleWWDRCAG3.cer`; writes `standin.p12`, `standin-aes.p12`, `standin.mobileprovision`
  (password `hunter2`). Its leaf is signed by a throwaway key, not by G3, so
  `isSigned(by:)` against G3 is false by design. Re-running changes the key, serial and
  UUID — the three files must stay together. It does **not** make `testcert.p12` or
  `testkey.*`.
- `tools/gen-apple-certs.py` (47 lines) turns Apple's 8 `.cer` files into
  `Certs/AppleCertificates.swift`, 76-character base64 inside a multi-line string.
- `testcert.p12` and `testkey.*` were made with rcodesign by hand and cannot be
  regenerated from the repo — worth a script of their own (and it would fix F1 at the same
  time).

---

## G. Docs, CI and repo hygiene

### G1 · Medium · fixed in this pass — the docs understated the tests
The README said "99 tests" and `docs/PLAN.md` said "78 tests". It is **126**, 86 of which
run without the sample apps. Both lines were corrected while this document was written,
because a count is a fact, not behaviour. No code changed.

### G2 · Medium · in the code — `docs/PLAN.md` and `docs/FEATURES.md` describe an older app
PLAN's "Next, in order" still lists certificate checking on a timer (done), batch signing
and update-all (half done: single app only, `docs/DECISIONS.md`), clones (done as
`separateCopy`), the files screen (done), ESign sources (done), Apple account sign-in (not
done) and pairing-file install (done, unverifiable here). FEATURES' table is accurate but
still names `Model/Updates.swift` and `Model/BackgroundRefresh.swift`, both of which exist.

### G3 · Low · in the code — the README's "Honest limits" are still honest
Signing needs a `.p12`; App Store-locked apps need a decrypted copy; installing needs the
helper or a web certificate; iOS 26.5–26.7 can sit at "Waiting…". Nothing there is out of
date.

### G4 · Note — CI takes about 3 minutes
`engine-tests` in `swift:6.0` (Linux) then `app` on `macos-15` with XcodeGen, Xcode 16.4,
`CODE_SIGNING_ALLOWED=NO`, an ad-hoc `codesign -` on the payload, and a release tagged
`build-<run_number>`. The version comes from `github.run_number` for the app and the
extension both.

### G5 · Low · in the code — 22 no-op commits
Every MAIPA-G setup run adds another `Set up MAIPA-G Autonomous [skip ci]` commit. Harmless,
but the history now hides the real work; squashing them later would help `git log`.

---

## H. Built and working, for the record

So the list above does not read as if nothing works. These were checked in the code and are
sound:

- Zip, ZIP64, symlinks, permissions, streaming at 12 MB — tested and passing.
- Hashes, HMAC, AES, DES/3DES, RC2, CBC, PBKDF2, BigInt basics, RSA sign/verify — tested.
- DER encode and parse; entitlements XML and DER pinned to GBox's and rcodesign's bytes;
  requirements text pinned byte for byte.
- CMS envelope shape; `cdhashPlist`.
- `.p12` in both 3DES and AES flavours; X.509 and PEM basics; chain building to Apple's
  roots; OCSP request shape and parsing.
- Lockdown framing, AFC packets, pairing-file parsing (aside from C1's operation code).
- Share codes (ESign, KravaSign, MapleSign, FlareStore), the trace file, version compare.
- The 33 build on 2 November compiled clean and published a 1.6 MB `.ipa`.

---

## The ten to fix first

1. **F1** — CI goes red on 27 December 2026. Fix before then; it is one assertion.
2. **C1** — pairing-file installs cannot work while the file-open answer is read as op 2.
3. **C13** — both HTTP listeners answer the whole Wi-Fi network.
4. **C2** — one malformed `Range` header traps the app.
5. **B1** — plain-`http` sources fail because of the ATS key combination.
6. **E1** — the Substrate → ElleKit swap can crash the app it just signed.
7. **E8** — a malformed `.ipa` crashes instead of showing an error.
8. **A1** — "Sign this app" from the File tab does not open the Sign screen.
9. **A2** — big apps freeze the screen on the main thread.
10. **B14** — updating deletes the old copy before the new one is installed.

## Everything marked suspected or needing a device, in one place

**Suspected** (follows from the code, needs a run to prove): A11, A17, A20's trace-picker
and certificate-picker notes, B6, B20, C3, C4, C5, C6, C8, C10, C11, C20, C21. D27 is
unverified; F2 is certain but only bites where the sample apps exist.

**Needs a device:** C1 (external check, then a phone), and everything listed in C27 —
`InstallServer`, `LockdownClient`, `DeviceInstaller`, `UDIDReader` and `KeychainTLS` have
never run against a real iPhone. Each entry above says what would settle it.

---

*Read on 15 November 2026 at commit `6f82d94`. Nothing in the code was changed to make this
document. Three other lines moved with it: the stale test counts in `README.md` and
`docs/PLAN.md` (G1), the `docs/AUDIT.md` row in the README's layout table, and a note in
`docs/DECISIONS.md` saying why this was written before anything was fixed.*
