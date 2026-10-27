# Choices made while building, and why

Small decisions that were taken without asking, so they can be changed. Newest first.

## 26 October 2026

**My apps and Sign are one screen.** The Sign tab opened with nothing chosen, so signing always
started by picking the app a second time. Signing now starts from the list: "Sign an app" at the
top for a file not added yet, Sign on a row, hold a row for "Sign again". Four tabs left: File,
My apps, Sources, Settings. `.signThisApp` now goes to My apps, which pushes the Sign screen.

**Only the root screen puts up the install sheet** (`Store.pendingInstall`). Three screens each
had their own; two could fight.

**Theme is kept in `appTheme`** (system / light / dark), separate from `SigningOptions.appearance`,
which forces the look of an app being signed.

**Updates do one app at a time.** Signing a big app uses the whole phone, so other Update buttons
grey out while one runs.

**After an update, the old version's row goes, and so does the download's own row** - but the
downloaded `.ipa` file stays on the File tab, because a download should stay where downloads go.

**Icons: the app's compiled image set (`Assets.car`) is kept.** iPhone only looks in it for the
icon because of `CFBundleIconName`, so that key goes and the file stays. Deleting it, which the
engine used to do and other signers still do, takes every other picture in the app with it.
Worst case now: the icon does not change.

**Looking inside an app reads signatures only for programs under 64 MB.** A signature sits at the
end of a program, so reading it means reading the whole file out of the zip; load commands are at
the front, so what each program links is always read. A huge game's main program says "too big to
read the signature here" instead of reading gigabytes on a phone.

**Order of the remaining features changed.** Done: updates for source apps (1), the permissions
editor (3), the icon picker and the icon fix (half of 4), what is inside an app (5). Encrypted
ESign sources (2) are **blocked**: nothing public spells the format out, and guessing it is
pointless. It needs the address of an encrypted ESign repo to work from. Reading an icon out of
`Assets.car` (the other half of 4) needs a reader for Apple's catalogue format - a big engine
piece, and every real app checked here ships loose icon files, so it waits until an app actually
turns up blank.

## 27 October 2026 — the rest of the eleven

**Encrypted ESign repos are share codes, not feeds.** `source[` + base64, every byte flipped
against a fixed 5056-byte key that ships inside ESign; KravaSign, MapleSign and FlareStore use
base64 with their own separators. Format and key from FlareStore's public Repository Decoder
page, whose own note says the key matches ESign's `RepoSourceParser`. Implemented both ways, so
Signer can hand its list to someone using ESign. The test pins our flipping against a code
worked out outside Swift from that key, not against itself.

**Editing a file inside an app does not unpack the app.** Edits are held as "write this file
instead" and handed to the engine when signing starts (`SigningOptions.replaceFiles`), written
while the app is unpacked and before Signer's own switches, so an edited `Info.plist` is the
starting point and the switches still win over it. A path pointing outside the app is refused.
Only simple settings can be typed over; lists and groups are kept exactly as they were, which
is the honest thing to offer on a phone keyboard.

**The Dynamic Island is a separate target.** `App/SignerActivity`, sharing one small file with
the app because iOS copies those values between the two. It asks for iOS 16.1 while the app
still runs on 16.0. Updates are held back to about one a second: iOS gives a Live Activity a
small budget and the engine reports progress hundreds of times a second.

**Shortcuts that sign or install open the app.** A shortcut gets seconds of background time and
signing a game takes minutes, so those two hand the job to Signer and let it do the work.
Checking sources and asking what is waiting run inside the shortcut.

**classdump follows half-built pointers.** Newer programs hand their pointers to iOS unfinished:
the low 36 bits are an offset into the program, and a parent class that lives in iOS is not a
pointer at all but a borrowed name, read out of the program's own table of borrowed names.
Method lists come in two shapes, pointers and small relative offsets; both are read. The newer
Swift name shape (`$s…`) is left packed - unpacking it properly is a job in itself.

**Assets.car is read for its contents, and handed to iOS for its pixels.** The structure, names,
sizes, scales and packings are all read in the engine (checked against four real apps). The
pixels come in packings Apple has never written down, so rather than guess, the file is handed
to iOS: a folder with the image set and a tiny Info.plist in it is a bundle, and `UIImage`
reads the icon straight out of it. That path runs only when an app has no icon file of its own.

**Pairing-file installs use plain sockets.** The protocol starts in the clear and turns the same
connection secure half way through, which the newer networking stack cannot do; the client
certificate out of the pairing file goes into the keychain so iOS will build an identity from
it, and is taken out again afterwards. The phone's own certificate is self-signed, so it is
accepted on purpose - holding the pairing file is what proves it is the right phone. **Not
tested on a device from here**: it needs a pairing file and a reachable install service. "Say
hello to iOS's install service" in Settings is the first thing to try and says exactly what
happened.
