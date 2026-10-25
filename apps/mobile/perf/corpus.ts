/*
 * The phone's own stress pages, as a .design folder, beside desktop's stress corpus
 * (stress.design) and the brand design's Applications page. What a phone shows that a desktop
 * page doesn't stress: many fit-content phone screens in a filmstrip (each measured before the
 * page frames itself), pins on nodes, and boards with small loops a phone shows at a third of
 * the screen. Deterministic; it never touches anything but the folder it's given.
 *
 *   bun apps/mobile/perf/corpus.ts <dir>     # writes <dir>/phone.design
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: bun apps/mobile/perf/corpus.ts <dir>");
  process.exit(2);
}
const root = join(dir, "phone.design");
rmSync(root, { recursive: true, force: true });

let seed = 7;
const rand = () => {
  seed = (seed * 16807) % 2147483647;
  return seed / 2147483647;
};
const pick = <T>(a: T[]) => a[Math.floor(rand() * a.length)]!;
const WORDS =
  "plan invite chores grocery bill money settle home share split rent coffee rota bins laundry dinner budget week month reminder household".split(
    " ",
  );
const words = (n: number) => Array.from({ length: n }, () => pick(WORDS)).join(" ");
const id = (p: string, i: number) => `${p}_${i.toString(36).padStart(5, "0")}`;
let node = 0;
const n = () => `n_${(node++).toString(36).padStart(6, "0")}`;

/** A phone screen with fit-content height: a header, a list of `rows`, a tab bar. */
function screen(i: number, x: number, y: number, rows: number, loop: boolean) {
  const hue = Math.floor(rand() * 360);
  const list = Array.from(
    { length: rows },
    (_, r) =>
      `<div data-id="${n()}" style="display:flex;gap:12px;align-items:center;padding:12px 20px;border-bottom:1px solid #eee"><div data-id="${n()}" style="width:40px;height:40px;border-radius:12px;background:hsl(${(hue + r * 17) % 360} 70% 60%)"></div><div data-id="${n()}" style="flex:1"><div data-id="${n()}" style="font:600 15px/20px Inter,sans-serif">${words(3)}</div><div data-id="${n()}" style="font:13px/18px Inter,sans-serif;color:#777">${words(6)}</div></div><div data-id="${n()}" style="font:600 15px Inter,sans-serif">£${(rand() * 90).toFixed(2)}</div></div>`,
  ).join("");
  const spinner = loop
    ? `<div data-id="${n()}" class="spin" style="width:28px;height:28px;border-radius:50%;border:3px solid #ddd;border-top-color:hsl(${hue} 70% 50%)"></div>`
    : "";
  return `<section data-artboard data-id="${id("ab", i)}" data-name="Screen ${i + 1}" data-x="${x}" data-y="${y}" style="width:390px;background:#fff;color:#111;font-family:Inter,sans-serif;display:flex;flex-direction:column">
<style>.spin{animation:spin 0.9s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}.pulse{animation:pulse 1.6s ease-in-out infinite}@keyframes pulse{50%{opacity:.4}}</style>
<div data-id="${n()}" style="height:54px"></div>
<div data-id="${n()}" style="display:flex;align-items:center;justify-content:space-between;padding:8px 20px 16px"><div data-id="${n()}" style="font:700 30px/36px Inter,sans-serif">${words(2)}</div>${spinner}</div>
<div data-id="${n()}"${loop ? ' class="pulse"' : ""} style="margin:0 20px 12px;padding:16px;border-radius:16px;background:hsl(${hue} 80% 95%)"><div data-id="${n()}" style="font:600 13px Inter,sans-serif;color:hsl(${hue} 60% 35%)">${words(2)}</div><div data-id="${n()}" style="font:700 28px/34px Inter,sans-serif">£${(rand() * 900).toFixed(2)}</div></div>
${list}
<div data-id="${n()}" style="display:flex;justify-content:space-around;padding:12px 0 34px;border-top:1px solid #eee">${Array.from({ length: 4 }, () => `<div data-id="${n()}" style="width:24px;height:24px;border-radius:6px;background:#ddd"></div>`).join("")}</div>
</section>`;
}

const pages: { id: string; name: string; boards: string[] }[] = [];
// start: one small board, where the design opens.
pages.push({ id: "pg_phone0", name: "start", boards: [screen(9000, 0, 0, 3, false)] });
// filmstrip: 60 fit-content phone screens, 6 rows of 10, lists of 6 to 30 rows.
{
  const boards: string[] = [];
  for (let i = 0; i < 60; i++)
    boards.push(
      screen(i, (i % 10) * 470, Math.floor(i / 10) * 1500, 6 + Math.floor(rand() * 24), false),
    );
  pages.push({ id: "pg_phone1", name: "filmstrip", boards });
}
// loops: 24 screens, every one with a spinner and a pulse.
{
  const boards: string[] = [];
  for (let i = 0; i < 24; i++)
    boards.push(screen(100 + i, (i % 8) * 470, Math.floor(i / 8) * 1100, 8, true));
  pages.push({ id: "pg_phone2", name: "loops", boards });
}
// pins: 12 screens with 8 threads each, half on nodes.
const threads: object[] = [];
{
  const boards: string[] = [];
  for (let i = 0; i < 12; i++) {
    const first = node;
    boards.push(screen(200 + i, (i % 6) * 470, Math.floor(i / 6) * 1200, 12, false));
    for (let k = 0; k < 8; k++)
      threads.push({
        id: id("th", i * 8 + k),
        artboardId: id("ab", 200 + i),
        ...(k % 2 ? { nodeId: `n_${(first + 8 + k * 5).toString(36).padStart(6, "0")}` } : {}),
        x: 30 + Math.floor(rand() * 330),
        y: 60 + Math.floor(rand() * 700),
        status: "open",
        createdAt: 1792000000000 + k,
        updatedAt: 1792000000000 + k,
        messages: [
          {
            id: id("m", i * 8 + k),
            author: { kind: "user", name: "You" },
            text: words(8),
            createdAt: 1792000000000 + k,
          },
        ],
      });
  }
  pages.push({ id: "pg_phone3", name: "pins", boards });
}

mkdirSync(join(root, "pages"), { recursive: true });
writeFileSync(
  join(root, "design.json"),
  `${JSON.stringify({ ponzu: 1, name: "Phone corpus", pages: pages.map(({ id, name }) => ({ id, name })) }, null, 2)}\n`,
);
writeFileSync(join(root, "tokens.css"), ":root {}\n");
writeFileSync(join(root, "comments.json"), `${JSON.stringify({ threads }, null, 2)}\n`);
for (const p of pages) {
  const folder = join(root, "pages", p.name);
  mkdirSync(folder, { recursive: true });
  p.boards.forEach((b, i) =>
    writeFileSync(join(folder, `${String(i).padStart(3, "0")}.html`), `${b}\n`),
  );
}
console.log(
  `phone.design: ${pages.map((p) => `${p.name} ${p.boards.length}`).join(", ")}, ${threads.length} threads`,
);
