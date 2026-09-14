# assets/ — ROM drop location (runtime only)

This directory is where the game ROM is dropped **at deploy time**. It is intentionally
empty in the repository.

Place your legally-owned ROM here with this exact filename so the app auto-boots it:

```
assets/Super Mario All-Stars (USA).sfc
```

## Important

- The ROM is **copyrighted** and is **NEVER committed** to this repository. It is
  git-ignored (`assets/*.sfc`, `assets/*.smc`).
- There is **no file picker** in the app. The engine auto-fetches the exact path above
  on load. If the file is missing, the app renders a graceful "ROM not found" notice and
  the UI stays usable in a disabled state — it will not crash and will not fall back to a
  file chooser.
