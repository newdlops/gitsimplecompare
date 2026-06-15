# Publishing Checklist

Publisher: `newdlops`  
Extension ID: `newdlops.git-simple-compare`

## Required Assets

- Marketplace icon: `resources/icon.png` (128x128 PNG)
- Activity Bar icon: `resources/activitybar.svg`
- Source icon: `resources/icon.svg`
- README: `README.md`
- Korean README: `README.ko.md`
- Changelog: `CHANGELOG.md`
- License: `LICENSE`

## Preflight

```bash
npm install
npm run check-types
npm run package
npx @vscode/vsce package
```

After packaging, install the generated VSIX in a clean VS Code window:

```bash
code --install-extension git-simple-compare-0.1.0.vsix
```

Check these flows before publishing:

- Open the Git Simple Compare Activity Bar view.
- Compare two branches.
- Compare a file with a branch.
- Open Git Graph.
- Open staged pull request preview and select a target branch.
- Verify AI buttons show the expected disabled/login/settings states.
- Verify Korean display language loads package and runtime translations.

## Publish

Log in once with the Visual Studio Marketplace publisher account:

```bash
npx @vscode/vsce login newdlops
```

Publish the current `package.json` version:

```bash
npx @vscode/vsce publish
```

For CI or a one-off token-based publish:

```bash
VSCE_PAT=<token> npx @vscode/vsce publish -p "$VSCE_PAT"
```

## Versioning

Before each publish:

1. Update `version` in `package.json`.
2. Move user-visible entries from `CHANGELOG.md` `[Unreleased]` into the new version section.
3. Run `npm run check-types` and `npm run package`.
4. Create and install a VSIX locally.
5. Publish with `npx @vscode/vsce publish`.

## Marketplace Metadata

Keep these fields in `package.json` aligned with the published listing:

- `publisher`: `newdlops`
- `repository.url`: `https://github.com/newdlops/gitsimplecompare.git`
- `bugs.url`: `https://github.com/newdlops/gitsimplecompare/issues`
- `homepage`: `https://github.com/newdlops/gitsimplecompare#readme`
- `icon`: `resources/icon.png`
- `galleryBanner`: dark theme banner color
