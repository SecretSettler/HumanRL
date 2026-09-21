# Third-Party Notices

IntentTrace is licensed under GNU AGPL v3.0 only (`AGPL-3.0-only`). Third-party components are not relicensed by IntentTrace and remain subject to their own license terms. The production dependency inventory includes permissive and weak-copyleft components; this repository-level review is not a substitute for release-specific legal review of the exact distributed or network-deployed form.

## Bundled asset

| Component           | Version/source | License                   | License text                                                                           |
| ------------------- | -------------- | ------------------------- | -------------------------------------------------------------------------------------- |
| Inter variable font | Inter Project  | SIL Open Font License 1.1 | [`apps/web/app/fonts/LICENSE-Inter-OFL.txt`](apps/web/app/fonts/LICENSE-Inter-OFL.txt) |

## Production dependency licenses

The lockfile currently contains production dependencies under these SPDX expressions:

- MIT
- Apache-2.0
- ISC
- BSD-3-Clause
- BlueOak-1.0.0
- Unlicense
- 0BSD
- CC-BY-4.0
- MPL-2.0
- LGPL-3.0-or-later
- EPL-2.0 OR GPL-3.0-or-later

Components that require particular distribution attention include:

| Component                                    | Current lockfile version | License/compliance note                                                                                                                                                                                                                                                                                           |
| -------------------------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `elkjs`                                      | 0.12.0                   | Dual licensed `EPL-2.0 OR GPL-3.0-or-later`; for an AGPL-covered combined work, IntentTrace elects the GPL-3.0-or-later option. AGPLv3 section 13 expressly permits linking/combining with GPLv3-covered work while retaining the respective section 13/network terms. Preserve the upstream license and notices. |
| `@img/sharp-libvips-linux-x64`               | 1.3.0                    | Bundles libvips under `LGPL-3.0-or-later`; distribution must preserve the LGPL notices and relinking/replacement rights applicable to the shipped form.                                                                                                                                                           |
| `lightningcss`, `lightningcss-linux-x64-gnu` | 1.32.0                   | MPL-2.0; preserve the license and source availability obligations for modifications to MPL-covered files.                                                                                                                                                                                                         |
| `caniuse-lite`                               | 1.0.30001806             | Browser compatibility data is CC-BY-4.0; preserve attribution.                                                                                                                                                                                                                                                    |

This file is a repository compliance aid, not a substitute for the complete license texts or legal review. Exact transitive versions can change when `pnpm-lock.yaml` changes. Before distributing a container, desktop bundle, or other binary artifact, regenerate and review the production inventory:

```bash
pnpm licenses list --prod
pnpm audit --prod
```

Also inspect each distributed package's `LICENSE`, `NOTICE`, and source-offer requirements. Any network deployment of a modified IntentTrace build must provide the Corresponding Source offer required by AGPLv3 section 13 through an appropriately prominent interface affordance. The macOS DMG workflow does not currently generate a complete machine-readable notices bundle automatically; public DMG distribution remains gated on a release-specific compliance review in addition to codesign/notarization.
