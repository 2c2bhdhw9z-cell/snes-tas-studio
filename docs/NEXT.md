# What people would want next

15 November 2026. Written after `docs/AUDIT.md`, from the same read of the whole repo.

Three lists, the way the owner asked for them: **things people would like**, **things that
need fixing before anything else**, and **things that are only half built**. Nothing here is
invented: each line names the file it touches, so the work can start without reading this
document's mind.

Needs nothing to be decided first. Ordered by what a person would notice soonest.

---

## 1. Quality of life and new features

### Signing

- **Sign a copy without asking twice.** The Sign screen already has every switch. A "remember
  these settings for next time" on it would end the walk through six sections for the second
  app. Small: the switches' values into `@AppStorage`, read back in `SignView`.
- **More than one app at a time.** `SigningRunner.run` handles one job and the screen says so,
  but nothing in the engine cares. A queue — several apps picked in My apps, signed in turn,
  installed at the end — is the single most-requested thing in every signer's community.
  Needs the global "one job" guard from `docs/AUDIT.md` B8 first.
- **Cancel a signing run.** There is no way out of a big app once it starts; the only stop is
  to swipe the app away. `IPASigner` takes a progress callback already, so a `shouldStop`
  flag checked in the same loop is the whole change.
- **Say what will change before signing.** A summary at the top of the Sign screen — "ID kept,
  2 add-ons, name unchanged, minimum iOS lowered to 14" — instead of the person reading the
  switches back. Every one of those values is already in `SigningOptions`.
- **A signing history.** "What did I sign, with which certificate, when" is one list of the
  last ten runs. `Trace` is written on every run already; it is not kept as history.

### The library and sources

- **Search and sort in My apps.** The File tab searches; My apps does not. With 40 apps that
  is the difference between a list and a tool. `LibraryView.swift` only.
- **Show what is installed but not in My apps** — swiping through Home Screen icons is the
  only way to know today. Needs an API iOS does not give an ordinary app (no
  `LSApplicationWorkspace`), so the honest version is a Shortcuts action that hands the list
  over from a signed-in sideloading app.
- **A real download manager.** `SourceFeed.swift:226` calls `URLSession.download(from:)`,
  which is one call that cannot be paused, resumed, cancelled or shown a true percentage.
  A delegate-based session fixes all four, and is the prerequisite for the keep-awake in
  `docs/AUDIT.md` B11.
- **Sources: refresh one, refresh all, and say when it last worked.** `Source.lastRefreshed`
  and `appCount` exist in `Models.swift:157-158` and are never written. Five lines.
- **A source's news, screenshots and full description.** `SourceFeed` parses all three
  (`SourceApp.fullDescription`, `screenshots`, `newsCount`) and no screen shows any of them.
  The App Store's detail page, from data already in hand.
- **App Store–style app page** before downloading: icon, name, version, what's new, size,
  screenshots, and the Get button. All of it is parsed; none of it is drawn.

### Files, certificates and small things

- **Select several files, apps and sources, then delete them together.** Done in this build:
  `Views/SelectionBar.swift` adds it to the File tab, My apps and Sources. A "Select" button
  in the toolbar turns every row into a check box, the bar along the bottom shows how many are
  picked with All / None and Delete, and each tab asks once before deleting. Folders on the
  File tab are picked and deleted whole, and the confirm says how many are going.
- **A folder picker in the File tab: make, rename, move.** Today the list only walks existing
  folders. `FileEntry.list` already knows what a folder is.
- **Sort the File tab** by name, size, date, and newest first. It is always name-then-folder.
- **Show free space** in Settings' Storage section, and how much the cache holds. One
  `URLResourceValues.volumeAvailableCapacityForImportantUsage` call.
- **A certificate's full chain, drawn.** `CertificateDetailView` shows fingerprints; the
  intermediate and root are already parsed.
- **Bulk certificate check**, not one button per run, and a "check expired ones on launch"
  switch. `CertificatesView.checkAll` exists; it is the waiting that hurts.
- **Colour and icon choices** — the theme is three options and the icon is the placeholder
  from build 1. `docs/PLAN.md:44` has been asking about the icon since October.

### Platform

- **Share sheet everywhere.** A signed app has Install and nothing else. "Share as `.ipa`" to
  AirDrop it to a computer is one `ShareLink` and the one thing a person with two phones
  wants.
- **Widget and Lock Screen.** A small widget with "3 updates waiting" and "last signed".
  `SigningIsland` already writes to App Group storage the widget could read.
- **Shortcuts: download, not just sign.** The four existing actions are listed in
  Settings; a "Download an app from a source" one would let a shortcut do the whole job.
- **TestFlight-style install**: install several apps in a row without closing Signer between
  them. Needs the install server to keep running instead of `stop()`-ing on hand-off.

---

## 2. Needs fixing first

Taken from `docs/AUDIT.md`, in the order a person would hit them. Each ID there has the
detail and the file.

| # | What a person sees | Audit entry | Effort |
|---|---|---|---|
| 1 | The build goes red on 27 December 2026 and every release stops | F1 | one line |
| 2 | "iOS would not let a file be written…" — pairing-file installs never work | C1 | one number, plus its test |
| 3 | Any app on the same Wi-Fi can download what is being installed | C13 | one bind address |
| 4 | One odd `Range:` header traps the app | C2 | four lines |
| 5 | Sources that give a plain `http://` address never load | B1 | one plist key |
| 6 | A tweaked app can crash on launch after the Substrate→ElleKit swap | E1 | renumber the load command |
| 7 | A malformed `.ipa` crashes instead of saying what is wrong | E8 | a guard |
| 8 | "Sign this app" on the File tab does nothing until My apps has been opened | A1 | move the listener |
| 9 | A 2 GB app freezes the screen while it is read | A2 | five `Task.detached` |
| 10 | Updating an app deletes the old copy before the new one installs | B14 | delete after hand-off |
| 11 | The screen locks during a long sign if the quiet-audio trick was refused | B10 | do not stop audio on expiry |
| 12 | Two taps can start two signing jobs that overwrite each other | B8 | one `isRunning` guard |
| 13 | The "updates waiting" notification can never be turned on | B2 | ask at the right time |

The first four are each under ten lines. They are the difference between "works" and
"works, and the release after this one still builds".

---

## 3. Half built, or waiting on something

Not bugs — work that was started and is not finished, so it looks done from the outside.

| What | Where it stops | What it needs |
|---|---|---|
| `.deb` add-ons | `SignView.swift:153` filters them out; `Info.plist` claims the type | A `.deb` reader (it is an `ar` archive with a `data.tar` inside, both formats are simple) and a dylib path picker (`docs/AUDIT.md` D19) |
| Cancelling an install | `InstallServer.stop()` is the only stop | A button on `InstallView` that cancels the listener and the connections |
| App Clips | `BundleSigner` signs them as ordinary nested bundles | Their own profile and entitlement rules (`docs/AUDIT.md` D16) |
| Watch apps | Signed with the phone's profile; `_WatchKitStub` left in place | A watch profile, or a warning that it will not run on a watch (`docs/AUDIT.md` D15) |
| The on-phone install | Falls back to the helper silently, and the host cannot be changed | Honour the setting, and a host field in Settings (`docs/AUDIT.md` A5, A6) |
| Reading icons out of `Assets.car` | On the phone only; the engine has four packings | Five known packings, documented in `docs/FEATURES.md:64` |
| The certificate check on a timer | A button only | A background task, the way sources already use one |
| Apple ID sign-in | `docs/PLAN.md:23` still lists it | Apple's own endpoints, and a decision about storing an Apple ID on the phone |
| Batch signing / update-all | `docs/DECISIONS.md`: one app at a time, on purpose | The queue in §1, then the decision can be revisited |
| The app's name and icon | Still "Signer" with the placeholder icon | The owner's answer (`docs/PLAN.md:44`) |

---

## 4. If only one thing gets done

**The cancel button.** Every other item assumes the person can wait for a job to finish. A
4 GB app is minutes of a phone that cannot do anything else, and the only way out today is to
kill the app and hope the leftovers are cleaned up. A flag checked once per file is a small
change with a large effect on how the app feels.
