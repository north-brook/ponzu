---
name: ponzu-implement-design
description: Implement a Ponzu design in the codebase. Use when asked to build, ship or code a design that lives in a .design folder.
---

# Design → code

The `.design` folder is the spec. Read it from disk:

- `tokens.css`: map into the codebase's theme. Keep the names.
- `pages/<page>/<artboard>.html`: exact sizes, colors, spacing and type, plus `data-name` labels for each part.
- `comments.json`: open threads may hold requirements ("collapse on mobile").
- `notes/`: the brief and the decisions made along the way.
- `Note: …` artboards: annotations that explain the screens beside them.

Build with the codebase's own components and conventions. Translate the structure; don't paste the HTML.
Keep the flex and grid decisions, the spacing scale and the type scale.

When something can't be built as drawn, leave a comment on that node (Ponzu MCP `create_comment`) saying what you did instead.
