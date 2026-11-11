# Fonts

The studio's fonts, which `fonts.css` declares and `../cloud.css` brings into every page
(the app, and the gallery its picture tests draw). They are the files Google Fonts served for the
stylesheet the studio used to link, so the app, its headless tests and the gallery's pictures
never wait on the network, and text draws exactly as it did: every gallery composition, drawn
with its text showing, is the same picture as before.

The styles use Inter 400 to 600 (the face is variable in weight and optical size), upright and in
Inter's own italic (the thread's asides are set in it), Funnel Display 600 for headings and IBM
Plex Mono 400 and 500 (what asks for Plex at 600 gets the 500 face, as it always has). The old link also asked for Funnel Display 700, which nothing uses; it was the same
file as 600, so leaving it out saves no file, only an unused `@font-face`.

Each Latin, Latin Extended, Cyrillic, Greek or Vietnamese file (and Plex's symbols2, its box
drawing) is a subset: the browser fetches it only when a page shows one of its characters.

## Where they came from

Fetched on 2026-11-11 from Google Fonts, with a current Chrome's User-Agent (so the answer is
WOFF2, cut into subsets), from:

- <https://fonts.googleapis.com/css2?family=Inter:ital,opsz,wght@0,14..32,400..600;1,14..32,400..600&family=Funnel+Display:wght@600;700&family=IBM+Plex+Mono:wght@400;500&display=swap>

| File | From `https://fonts.gstatic.com` | SHA-256 (first 16) |
| --- | --- | --- |
| `funnel-display-latin-ext.woff2` | /s/funneldisplay/v3/B50WF7FGv37QNVWgE0ga--4Pbb6TDYs0gnHAA4E.woff2 | `20bc54b005a2bc3c` |
| `funnel-display-latin.woff2` | /s/funneldisplay/v3/B50WF7FGv37QNVWgE0ga--4Pbb6dDYs0gnHA.woff2 | `96468ae7727580c8` |
| `ibm-plex-mono-400-cyrillic-ext.woff2` | /s/ibmplexmono/v23/-F63fjptAgt5VM-kVkqdyU8n1iIq131nj-otFQ.woff2 | `c6f09ee0e0a24b7c` |
| `ibm-plex-mono-400-cyrillic.woff2` | /s/ibmplexmono/v23/-F63fjptAgt5VM-kVkqdyU8n1isq131nj-otFQ.woff2 | `77eabc24c693d98b` |
| `ibm-plex-mono-400-symbols2.woff2` | /s/ibmplexmono/v23/-F63fjptAgt5VM-kVkqdyU8n1pUL8lJPheIVLNg.woff2 | `5dfe096c2fc37fc7` |
| `ibm-plex-mono-400-vietnamese.woff2` | /s/ibmplexmono/v23/-F63fjptAgt5VM-kVkqdyU8n1iAq131nj-otFQ.woff2 | `7aa405510f9da1e3` |
| `ibm-plex-mono-400-latin-ext.woff2` | /s/ibmplexmono/v23/-F63fjptAgt5VM-kVkqdyU8n1iEq131nj-otFQ.woff2 | `e2318e4993a9cd4a` |
| `ibm-plex-mono-400-latin.woff2` | /s/ibmplexmono/v23/-F63fjptAgt5VM-kVkqdyU8n1i8q131nj-o.woff2 | `52de70091213c9ea` |
| `ibm-plex-mono-500-cyrillic-ext.woff2` | /s/ibmplexmono/v23/-F6qfjptAgt5VM-kVkqdyU8n3twJwl1FgsAXHNlYzg.woff2 | `311098be73eac339` |
| `ibm-plex-mono-500-cyrillic.woff2` | /s/ibmplexmono/v23/-F6qfjptAgt5VM-kVkqdyU8n3twJwlRFgsAXHNlYzg.woff2 | `c9507256e987c507` |
| `ibm-plex-mono-500-symbols2.woff2` | /s/ibmplexmono/v23/-F6qfjptAgt5VM-kVkqdyU8n3twJwupkp-8_FtFg95o.woff2 | `ca434d24cfdf35f0` |
| `ibm-plex-mono-500-vietnamese.woff2` | /s/ibmplexmono/v23/-F6qfjptAgt5VM-kVkqdyU8n3twJwl9FgsAXHNlYzg.woff2 | `4010f58bc2759100` |
| `ibm-plex-mono-500-latin-ext.woff2` | /s/ibmplexmono/v23/-F6qfjptAgt5VM-kVkqdyU8n3twJwl5FgsAXHNlYzg.woff2 | `ded8ac6ac2369f6c` |
| `ibm-plex-mono-500-latin.woff2` | /s/ibmplexmono/v23/-F6qfjptAgt5VM-kVkqdyU8n3twJwlBFgsAXHNk.woff2 | `f17f51948d10b67d` |
| `inter-cyrillic-ext.woff2` | /s/inter/v20/UcCo3FwrK3iLTcvvYwYZ8UA3J58.woff2 | `942b71451b22e42c` |
| `inter-cyrillic.woff2` | /s/inter/v20/UcCo3FwrK3iLTcvmYwYZ8UA3J58.woff2 | `a7f3e73668ccdd99` |
| `inter-greek-ext.woff2` | /s/inter/v20/UcCo3FwrK3iLTcvuYwYZ8UA3J58.woff2 | `009e52d835e45840` |
| `inter-greek.woff2` | /s/inter/v20/UcCo3FwrK3iLTcvhYwYZ8UA3J58.woff2 | `b6a22966401b2b88` |
| `inter-vietnamese.woff2` | /s/inter/v20/UcCo3FwrK3iLTcvtYwYZ8UA3J58.woff2 | `07df696d36deed37` |
| `inter-latin-ext.woff2` | /s/inter/v20/UcCo3FwrK3iLTcvsYwYZ8UA3J58.woff2 | `8bc9dee39deab5dc` |
| `inter-latin.woff2` | /s/inter/v20/UcCo3FwrK3iLTcviYwYZ8UA3.woff2 | `dd8a4575be980610` |
| `inter-italic-cyrillic-ext.woff2` | /s/inter/v20/UcCm3FwrK3iLTcvnUwkT9mI1F55MKw.woff2 | `974fe69be65d7e5c` |
| `inter-italic-cyrillic.woff2` | /s/inter/v20/UcCm3FwrK3iLTcvnUwAT9mI1F55MKw.woff2 | `925b918fe862f38f` |
| `inter-italic-greek-ext.woff2` | /s/inter/v20/UcCm3FwrK3iLTcvnUwgT9mI1F55MKw.woff2 | `dbc57e88c2780c49` |
| `inter-italic-greek.woff2` | /s/inter/v20/UcCm3FwrK3iLTcvnUwcT9mI1F55MKw.woff2 | `380e26a8b1f42bc7` |
| `inter-italic-vietnamese.woff2` | /s/inter/v20/UcCm3FwrK3iLTcvnUwsT9mI1F55MKw.woff2 | `3199b2e5db75b970` |
| `inter-italic-latin-ext.woff2` | /s/inter/v20/UcCm3FwrK3iLTcvnUwoT9mI1F55MKw.woff2 | `7d263a256b5858b2` |
| `inter-italic-latin.woff2` | /s/inter/v20/UcCm3FwrK3iLTcvnUwQT9mI1F54.woff2 | `124b693f9bb56633` |

| Family | Version in the files | Upstream (what Google Fonts builds from) | Licence |
| --- | --- | --- | --- |
| Inter | 4.001 (`git-66647c0bb`), Google Fonts `v20` | [rsms/inter](https://github.com/rsms/inter) at `66647c0` | [OFL-Inter.txt](OFL-Inter.txt) |
| Funnel Display | 1.000, Google Fonts `v3` | [Dicotype/Funnel](https://github.com/Dicotype/Funnel) at `f9509ce` | [OFL-FunnelDisplay.txt](OFL-FunnelDisplay.txt) |
| IBM Plex Mono | 2.3, Google Fonts `v23` | [googlefonts/plex](https://github.com/googlefonts/plex) at `9ab3b5b` | [OFL-IBMPlexMono.txt](OFL-IBMPlexMono.txt) |

All three are under the SIL Open Font License 1.1; each licence is the `OFL.txt` Google Fonts
publishes with the family (github.com/google/fonts, `ofl/<family>/OFL.txt`). The files are
byte-for-byte copies of what Google Fonts serves; only the file names are ours.

To take a newer version, fetch the same requests again, replace the files whose addresses
changed, and check that the gallery's references still hold
(`cd apps/studio && bun scripts/visual.ts references`, then `git status`).
