---
name: ponzu-code-to-design
description: Recreate an existing app screen or component in Ponzu so it can be redesigned. Use when asked to "bring this page into Ponzu" or redesign something that already exists in code.
---

# Code → design

1. Read the component and its styles in the codebase. Find the theme (CSS variables, Tailwind config, tokens file).
2. Mirror the theme into `tokens.css` with the same names.
3. Create an artboard at the screen's real size and rebuild the markup as static HTML with inline styles that use the tokens. Use real copy from the code, not lorem ipsum.
4. Screenshot and compare with the running app if you can see it. Match spacing and type exactly before changing anything.
5. Name the artboard "<Screen> / current" and leave it untouched. Do redesign work in duplicates beside it.
