# Logos on the start page tiles: sources and terms

The files in this folder are the original logos of the tools shown on the start page (`tools.json`, field `logo`).
They were retrieved on 2026-10-30, each from the official source of the product (repository, brand kit or the own
extension), and are served locally; the page never loads them from the internet. Except for the removal of the XML
prolog and of Inkscape/Illustrator comment lines (marked below), the files are byte-identical to the upstream files:
no color, shape or proportion was changed.

All logos are trademarks of their owners. They are used only to identify the tools on a local dashboard, no
endorsement or partnership is implied. A repository licence (MIT, Apache-2.0, AGPL-3.0, MPL-2.0) covers the code and
does not grant trademark rights.

| File | Tool | Size | Source (commit of the repository on the retrieval date) | Terms stated by the vendor |
|---|---|---|---|---|
| `workbench.svg` | Workbench (code-server, Coder) | 611 B | <https://raw.githubusercontent.com/coder/code-server/main/src/browser/media/favicon.svg> (`coder/code-server` @ `68810a6bd6f34356dc579214bc75a30b699500c4`) | Repository MIT; no separate logo terms found. Black-only mark: shown on a light box. |
| `gitea.svg` | Gitea | 2571 B | <https://raw.githubusercontent.com/go-gitea/gitea/main/assets/logo.svg> (`go-gitea/gitea` @ `eb3bc196ec00efd184b663dead91ca89ca2ee0c3`); XML prolog line removed | Repository MIT; no separate logo terms found. |
| `rustfs.svg` | RustFS console | 1215 B | <https://raw.githubusercontent.com/rustfs/design/main/public/brand/logo/rustfs-app-icon.svg> (`rustfs/design` @ `28fa50ac0a7d5e8dd6a606a11206dbdd7c87eed4`, brand kit <https://design.rustfs.com/en/downloads/>) | Brand kit terms of use: "May be used to refer to RustFS and its products. Never imply endorsement or partnership without written permission. Never modify the logo or use it in other marks. The Apache 2.0 licence grants no trademark rights." Unmodified. |
| `aantje.png` | aantje (own extension) | 38053 B | `media/icon.png` of the aantje repository (the `icon` of its `package.json`; 570 x 570 px), scaled down to 256 x 256 px, otherwise unchanged | Own artwork of the aantje project, same terms as the aantje extension. |

SHA-256 of the stored files:

```
179196a5ec3f20e1e41839722880924d858633810aa5a14b7e34e72733844258  workbench.svg
2cb4d44d76917d22712d12ef8be45a12caaafc3c571e00c7d4cdad588fce7bcb  gitea.svg
0702063364e73ffa83bfa99869c63ebaa5e49ee0dee23f606e9fdd5e70b15858  rustfs.svg
f82fb9733e2c81fa2542dfb2fcf18824220f23497d02f4b4f4f7865e305ff9fb  aantje.png
```
