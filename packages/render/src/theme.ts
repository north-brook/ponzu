/**
 * Runs in the page. In a design whose colors change with the theme, finds
 * text and surfaces that only work in one theme: a raw color beside a
 * light-dark() token, so one changes and the other doesn't. Reads every color
 * in both schemes by flipping color-scheme on the page, then puts it back.
 * Parts that set color-scheme themselves don't follow the flip and are left alone.
 * Designs with no theme render light everywhere, so they're skipped.
 */
export const THEME_LINT_SCRIPT = `(() => {
  const root = document.querySelector('[data-artboard]');
  if (!root || !/light-dark\\(|prefers-color-scheme/i.test(document.documentElement.outerHTML)) return [];
  const html = document.documentElement;
  // "light dark" lets the page's preference choose; "normal" is light.
  const declared = getComputedStyle(html).colorScheme;
  const dark = declared.includes('dark') && (!declared.includes('light') || matchMedia('(prefers-color-scheme: dark)').matches);
  const now = dark ? 'dark' : 'light';
  const other = now === 'dark' ? 'light' : 'dark';
  // Everything but the insides of SVGs, so every element's parent is here too.
  const els = [root, ...[...root.querySelectorAll('*')].filter((el) => !el.parentElement.closest('svg'))];
  const read = () => new Map(els.map((el) => {
    const cs = getComputedStyle(el);
    return [el, { color: cs.color, bg: cs.backgroundColor, scheme: cs.colorScheme }];
  }));
  // A color that changes would start a transition and read as its first frame.
  const still = document.createElement('style');
  still.textContent = '*, *::before, *::after { transition: none !important; }';
  document.head.append(still);
  const a = read();
  const was = html.style.getPropertyValue('color-scheme');
  html.style.setProperty('color-scheme', other);
  const b = read();
  if (was) html.style.setProperty('color-scheme', was);
  else html.style.removeProperty('color-scheme');
  getComputedStyle(root).color;
  still.remove();

  const follows = (el) => a.get(el).scheme !== b.get(el).scheme;
  if (!els.some((el) => follows(el) && (a.get(el).color !== b.get(el).color || a.get(el).bg !== b.get(el).bg))) return [];

  const cv = document.createElement('canvas');
  cv.width = cv.height = 1;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  const parsed = new Map();
  const rgba = (s) => {
    let c = parsed.get(s);
    if (c) return c;
    const m = /^rgba?\\(([\\d.]+),\\s*([\\d.]+),\\s*([\\d.]+)(?:,\\s*([\\d.]+))?\\)$/.exec(s);
    if (m) c = [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]];
    else {
      // oklch(), color(srgb …) and the rest: let the canvas convert it.
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = '#000';
      ctx.fillStyle = s;
      ctx.fillRect(0, 0, 1, 1);
      const d = ctx.getImageData(0, 0, 1, 1).data;
      c = [d[0], d[1], d[2], d[3] / 255];
    }
    parsed.set(s, c);
    return c;
  };
  const over = (top, under) => [0, 1, 2].map((i) => top[i] * top[3] + under[i] * (1 - top[3]));
  // The solid color behind an element: its background over its parents', over white.
  const behind = (pass) => {
    const memo = new Map();
    const eff = (el) => {
      if (memo.has(el)) return memo.get(el);
      const c = over(rgba(pass.get(el).bg), el === root ? [255, 255, 255] : eff(el.parentElement));
      memo.set(el, c);
      return c;
    };
    return eff;
  };
  const effA = behind(a);
  const effB = behind(b);
  const lum = (c) => {
    const [r, g, bl] = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const ratio = (x, y) => { const p = lum(x), q = lum(y); return (Math.max(p, q) + 0.05) / (Math.min(p, q) + 0.05); };
  const fmt = (r) => (r < 10 ? r.toFixed(1) : Math.round(r)) + ':1';
  const changes = (x, y) => Math.abs(lum(x) - lum(y)) > 0.05;
  const ownText = (el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
  // Surfaces holding text that changes with the theme. One that holds only its
  // own raw colors (a code block, a mock of a light app) is drawn that way on purpose.
  const holdsThemed = new Set();
  for (const el of els) {
    if (!ownText(el) || a.get(el).color === b.get(el).color) continue;
    for (let p = el; p && !holdsThemed.has(p); p = p === root ? null : p.parentElement) holdsThemed.add(p);
  }
  const label = (el) => el.getAttribute('data-name') || el.tagName.toLowerCase();
  const fix = 'Use light-dark() tokens for both, or set color-scheme on the part that should stay one way.';
  const issues = [];
  for (const el of els) {
    const id = el.getAttribute('data-id');
    if (!id || !follows(el)) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const ca = a.get(el), cb = b.get(el);
    // A surface: what it paints against what's behind it, in each theme.
    if (el !== root && rgba(ca.bg)[3] > 0 && holdsThemed.has(el)) {
      const sa = ratio(effA(el), effA(el.parentElement));
      const sb = ratio(effB(el), effB(el.parentElement));
      if (Math.min(sa, sb) < 1.3 && Math.max(sa, sb) >= 3) {
        const why = ca.bg !== cb.bg ? "changes with the theme and what's behind it doesn't" : "stays the same in both themes and what's behind it changes";
        issues.push({ id, kind: 'theme', message: label(el) + ' ' + why + ': ' + fmt(sa) + ' against its surroundings in ' + now + ', ' + fmt(sb) + ' in ' + other + '. ' + fix });
        continue;
      }
    }
    if (!ownText(el)) continue;
    const ta = ratio(over(rgba(ca.color), effA(el)), effA(el));
    const tb = ratio(over(rgba(cb.color), effB(el)), effB(el));
    if (Math.min(ta, tb) < 2 && Math.max(ta, tb) >= 4) {
      const color = ca.color !== cb.color;
      const ground = changes(effA(el), effB(el));
      const why = color && !ground ? "its color changes with the theme and its background doesn't"
        : !color && ground ? "its background changes with the theme and its color doesn't"
        : "its color and background don't change together";
      issues.push({ id, kind: 'theme', message: label(el) + ' text is ' + fmt(ta) + ' in ' + now + ' and ' + fmt(tb) + ' in ' + other + ': ' + why + '. ' + fix });
    }
  }
  return issues.slice(0, 10);
})()`;
