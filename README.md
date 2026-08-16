# PoE Personal Trade

A compact Windows overlay for user-triggered Path of Exile 1 live price checks. Hover an item in game, press `Alt+D`, choose the properties or modifiers that matter, and compare current listings from the official Path of Exile Trade service.

The interface can be switched between English and German. Mercenary Warrants, their skills, and individual supports are detected from the extended copied item text.

## Download and use

1. Download `PoE-Personal-Trade-Setup-<version>.exe` from [Releases](https://github.com/PLUMSKLO-dev/poe-personal-trade/releases/latest).
2. Install and start the app. A small in-game notification confirms that it is ready.
3. Hover an item in Path of Exile and press `Alt+D`.
4. Adjust filters if needed and run the live price check.

The installed edition checks GitHub Releases automatically, downloads newer versions in the background, and offers a restart when an update is ready. The portable EXE does not self-update.

Windows SmartScreen may warn about early beta builds because the project does not yet use a paid code-signing certificate. Verify that the download comes from this repository.

## What it does

- Parses normal, magic, rare, unique, synthesised, corrupted, and influenced items.
- Matches selectable item properties and official Trade stat filters.
- Detects Mercenary Warrant skills and supports from the right-click detail view.
- Retrieves live listings rather than storing a price database.
- Keeps running in the tray when the overlay is hidden.
- Replaces the visible price check when `Alt+D` is used on another item.

## Safety and privacy

- Every item read begins with an explicit user hotkey.
- The app does not inspect or modify the game process or memory.
- It does not request or store `POESESSID`, passwords, browser cookies, or game credentials.
- Searches use the official public Path of Exile Trade endpoints and respect server retry instructions.
- Local settings contain only the chosen language and league.

See [PRIVACY.md](PRIVACY.md) and [SECURITY.md](SECURITY.md) for more detail.

## Development

Requires Node.js, pnpm, and Windows for packaging.

```powershell
pnpm install
pnpm test
pnpm run build
pnpm run package:installer
pnpm run package:portable
```

Pushing a version tag such as `v0.23.0` runs the GitHub Actions release workflow and publishes the installer, portable build, update metadata, and blockmap.

## Credits and legal notice

Item parsing and trade-filter concepts were informed by [Awakened PoE Trade](https://github.com/SnosMe/awakened-poe-trade). See [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt).

Path of Exile and its data are property of Grinding Gear Games. This product isn't affiliated with or endorsed by Grinding Gear Games in any way.

Released under the [MIT License](LICENSE).
