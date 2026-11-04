# Branding

This page covers the images of the extension (`media/`), the pages shown on the Marketplace detail page (`README.md`, `LICENSE`, `CHANGELOG.md`) and the manifest test that keeps them consistent with `package.json`.

| Where                        | What the user sees                                                                                        |
| ---------------------------- | --------------------------------------------------------------------------------------------------------- |
| Extensions view, detail page | `media/icon.png`, the name `aantje`, the publisher `teitelberg`, the description, then the derived README |
| Activity Bar                 | `media/aantje-activity.svg` as the icon of the aantje view container                                      |
| README header on GitHub      | `media/logo.png`, centered above the heading                                                              |
| Changelog tab                | `CHANGELOG.md`; `LICENSE` ships in the VSIX as `LICENSE.txt`                                              |

## The logo

The logo is the work of the author, Tillmann Eitelberg: a navy duck with an orange beak on two slate slabs, on a transparent background. The master is `media/source/aantje.af` (Affinity). No script changes it, and `.vscodeignore` keeps it out of the VSIX. Pictures are used as drawn; only the Activity Bar glyph is redrawn, because it must be one colour.

| File                        | Used by                              | What it is                                                                                    |
| --------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------- |
| `media/source/aantje.af`    | Nobody; the master                   | Open it to change the logo, then export the files below.                                      |
| `media/logo.png`            | The README header                    | 528 x 570 px RGBA export of the master.                                                       |
| `media/icon.png`            | `icon` in `package.json`             | The same pixels centred on a square 570 x 570 px transparent canvas.                          |
| `media/aantje-activity.svg` | `viewsContainers.activitybar[].icon` | One-colour glyph of the duck, `viewBox` `-21 0 570 570`, shown at 24 px.                      |
| `media/aantje.svg`          | Nobody; kept for later use           | SVG export of the master. It only embeds the PNG, so it is no vector source. Not in the VSIX. |

When the logo changes, export the PNG, copy it to `media/logo.png`, pad it to `media/icon.png` the same way and redraw the glyph.

## Why these formats

**The extension icon is a square PNG.** `vsce` rejects an SVG as `icon`, and galleries expect a PNG of at least 128 px. The logo sits on a square canvas without scaling. The duck's outline is navy, so the icon needs a light background. In a dark theme the outline is hard to see in the Extensions view, which is why `galleryBanner` is light (`#FFFFFF`).

**The Activity Bar icon is an SVG mask.** VS Code uses the image as a CSS mask at 24 px and fills it with the theme colour, so only the alpha channel counts. The glyph is one `<path fill-rule="evenodd">` on a transparent background, without style sheet, picture, clip path or link. It is traced from the logo PNG (the author's SVG has no paths), with lines 3 px thicker than in the logo so the outline and the gap between the slabs stay open at 16 to 24 px. It was checked by eye on the usual dark, darker and light Activity Bar colours. A different logo needs a new glyph.

## README, licence and changelog

- `README.md` is the GitHub page and the source of the detail page. The detail page already shows icon, name and publisher, so `scripts/package.ps1` derives the packaged README: it drops the logo block, the `# aantje` heading and the sections Security and Documentation ([Packaging](packaging.md#the-vsce-flags)). VS Code shows the publisher but not the `author` field, so the README has an author block with `https://aantje.dev`. The long feature list lives in [Features](features.md).
- `LICENSE` is the MIT licence, shipped as `LICENSE.txt`.
- `CHANGELOG.md` is the Changelog tab. It lists the first release, the version that `package.json` keeps; later versions get generated release notes on GitHub, not an entry here, and there is no `Unreleased` section (a test refuses it).

### Images on the detail page

The detail page renders the README without a base URL and allows only `https:` and `data:` images, so a relative `media/logo.png` would not load. `package.json` has `repository`, so `vsce` rewrites relative image paths of `README.md` and `CHANGELOG.md` to `https://github.com/TEitelberg/aantje/raw/HEAD/<path>` and relative links to `.../blob/HEAD/<path>`. The repository keeps relative paths, so GitHub shows the same pictures. The screenshots therefore load from GitHub, only when the files are on the default branch of a public repository, and are not in the VSIX. `vsce` accepts only HTTPS pictures and no SVG in the README. The icon in the page header is `icon.png` and always works.

## The manifest test

A unit test reads `package.json`, the media files, `esbuild.mjs`, `LICENSE`, `CHANGELOG.md`, the README and some source files, and checks that they agree. It uses no mocks and starts no editor. It covers:

- identity: publisher, display name, homepage, author without e-mail, MIT licence;
- icons: `icon.png` is a square PNG of at least 128 px and the logo pixel for pixel, and the glyph is a single even-odd path of the allowed kind whose silhouette overlaps the logo;
- activation: `main` equals the `outfile` of `esbuild.mjs`, no activation event without a contribution behind it;
- commands and menus: unique ids with title and category `aantje`, every menu command declared and reachable, toolbar commands with an icon, the exact commands each node kind offers;
- context values: the `viewItem` conditions use only the context values of the tree;
- runtime: `extensionKind` is `workspace`, `aantje.connections` has machine scope, capabilities match [Security](security.md);
- changelog and README: an entry for the current version, settings and connection properties in tables, existing setting names and command titles, and values that match the manifest and the code.

When the tree gets a new `contextValue`, add it to the list in the test before using it in a menu.

## Known limits

- The logo and screenshots on the detail page need the files on GitHub; offline, the page shows gaps.
- The Activity Bar glyph is traced from a PNG, so it is less exact than a hand-drawn one.
- A dark theme shows the duck without its navy outline in the Extensions view. An icon with a white background would be an extra file and a logo change that the author has not asked for.
