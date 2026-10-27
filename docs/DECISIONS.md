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
