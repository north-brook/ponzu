# Fonts

The site's fonts, which `fonts.ts` declares with `next/font/local`. They are the files
`next/font/google` downloaded from Google Fonts at every build before; the build now reads them
from here, so it never waits on the network. Same files, same subsets and unicode-ranges, same
preloads (the Latin subsets) and the same fallback metrics (`fonts.css`): the built site's
`@font-face` rules and font files are what they were, the files byte for byte.

Inter is the variable face Google serves for every weight, without the optical-size axis (the
site never asked for it); the studio's Inter (apps/studio) is a different cut, with that axis.

Each Latin, Latin Extended, Cyrillic, Greek or Vietnamese file (and Plex's symbols2, its box
drawing) is a subset: the browser fetches it only when a page shows one of its characters.

## Where they came from

Fetched on 2026-11-11 from Google Fonts, with a current Chrome's User-Agent (so the answer is
WOFF2, cut into subsets), from:

- <https://fonts.googleapis.com/css2?family=Inter:wght@100..900&display=swap>
- <https://fonts.googleapis.com/css2?family=Funnel+Display:wght@600;700&display=swap>
- <https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&display=swap>

| File | From `https://fonts.gstatic.com` | SHA-256 (first 16) |
| --- | --- | --- |
| `inter-cyrillic-ext.woff2` | /s/inter/v20/UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa2JL7W0Q5n-wU.woff2 | `fccca918fea40089` |
| `inter-cyrillic.woff2` | /s/inter/v20/UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa0ZL7W0Q5n-wU.woff2 | `aebf2ab4a4ce6810` |
| `inter-greek-ext.woff2` | /s/inter/v20/UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa2ZL7W0Q5n-wU.woff2 | `a2e2c783ca6f9c20` |
| `inter-greek.woff2` | /s/inter/v20/UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa1pL7W0Q5n-wU.woff2 | `46dd4cdca58c26ae` |
| `inter-vietnamese.woff2` | /s/inter/v20/UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa2pL7W0Q5n-wU.woff2 | `8db00ff46c67b22c` |
| `inter-latin-ext.woff2` | /s/inter/v20/UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa25L7W0Q5n-wU.woff2 | `a28eb6d3ccb534ae` |
| `inter-latin.woff2` | /s/inter/v20/UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa1ZL7W0Q5nw.woff2 | `c940764593d0fe5d` |
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

| Family | Version in the files | Upstream (what Google Fonts builds from) | Licence |
| --- | --- | --- | --- |
| Inter | 4.001 (`git-66647c0bb`), Google Fonts `v20` | [rsms/inter](https://github.com/rsms/inter) at `66647c0` | [OFL-Inter.txt](OFL-Inter.txt) |
| Funnel Display | 1.000, Google Fonts `v3` | [Dicotype/Funnel](https://github.com/Dicotype/Funnel) at `f9509ce` | [OFL-FunnelDisplay.txt](OFL-FunnelDisplay.txt) |
| IBM Plex Mono | 2.3, Google Fonts `v23` | [googlefonts/plex](https://github.com/googlefonts/plex) at `9ab3b5b` | [OFL-IBMPlexMono.txt](OFL-IBMPlexMono.txt) |

All three are under the SIL Open Font License 1.1; each licence is the `OFL.txt` Google Fonts
publishes with the family (github.com/google/fonts, `ofl/<family>/OFL.txt`). The files are
byte-for-byte copies of what Google Fonts serves; only the file names are ours.

To take a newer version, fetch the same requests again, replace the files whose addresses
changed, and update the unicode-ranges in `fonts.ts` if Google's changed.
