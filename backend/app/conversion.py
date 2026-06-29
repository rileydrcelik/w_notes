"""Markdown → rich-text HTML conversion.

The note/copa body is stored as the native rich editor's HTML across every
device (the canonical, synced format). The web client edits in plain markdown,
so that markdown has to become the editor's HTML before it can render on mobile.
That conversion lives here, on the server, so there's a single authoritative
implementation (the web client calls ``POST /convert/to-html``; it keeps a JS
copy only as an offline fallback).

Output contract — the subset the native parser (``react-native-enriched``)
understands. The app runs every incoming body through its Gumbo HTML normalizer,
which already canonicalizes standard tags (``<strong>``→``<b>``, ``<pre>``→
``<codeblock>``, whitespace between block tags, …), so we only need to emit
sensible standard HTML **plus** two things the normalizer can't infer:

- GFM task lists. The normalizer drops ``<input type="checkbox">`` entirely, so a
  ``- [ ]`` list would collapse to plain bullets. We reshape task lists into the
  editor's native checkbox format: ``<ul data-type="checkbox">`` with
  ``<li>`` / ``<li checked>`` items.
- The ``<html>…</html>`` wrapper. The native editor only treats a body as rich
  text when it's wrapped; without it a web-edited note shows up as raw HTML.
"""

from __future__ import annotations

import re

import markdown as _markdown

# Reusable parser. ``extra`` brings fenced code + tables; ``sane_lists`` keeps
# ordered/unordered lists from bleeding into each other; ``nl2br`` matches the
# web editor's "soft newline = <br>" feel. Task lists are handled by us below
# (Python-Markdown leaves ``[ ]`` as literal text in the <li>), so no extension
# is needed for them.
_MD_EXTENSIONS = ["extra", "sane_lists", "nl2br"]

# A <ul> whose items all begin with a `[ ]` / `[x]` marker is a task list.
_TASK_ITEM = re.compile(
    r"<li>\s*\[(?P<mark>[ xX])\]\s*(?P<body>.*?)</li>",
    re.DOTALL,
)
_UL_BLOCK = re.compile(r"<ul>(?P<inner>.*?)</ul>", re.DOTALL)


def _reshape_task_lists(html: str) -> str:
    """Rewrite GFM task-list ``<ul>``s into the native checkbox format.

    Only lists whose *every* item carries a checkbox marker are converted, so a
    normal bullet list that merely starts with a literal ``[`` is left alone.
    """

    def replace_ul(match: re.Match[str]) -> str:
        inner = match.group("inner")
        items = re.findall(r"<li>.*?</li>", inner, re.DOTALL)
        if not items or not all(_TASK_ITEM.fullmatch(item.strip()) for item in items):
            return match.group(0)
        rebuilt = []
        for item in items:
            m = _TASK_ITEM.fullmatch(item.strip())
            assert m is not None  # guarded by the all() above
            checked = m.group("mark").lower() == "x"
            rebuilt.append(
                f"<li checked>{m.group('body').strip()}</li>"
                if checked
                else f"<li>{m.group('body').strip()}</li>"
            )
        return f'<ul data-type="checkbox">{"".join(rebuilt)}</ul>'

    return _UL_BLOCK.sub(replace_ul, html)


def markdown_to_html(md: str) -> str:
    """Convert web-editor markdown into a stored/synced rich-text HTML body.

    Returns an empty string for blank input (an empty note has an empty body, not
    an empty ``<html></html>`` wrapper).
    """
    if not md or not md.strip():
        return ""
    # The module-level helper builds a fresh parser per call, so there's no
    # cross-request state to reset.
    inner = _markdown.markdown(md, extensions=_MD_EXTENSIONS).strip()
    inner = _reshape_task_lists(inner)
    return f"<html>\n{inner}\n</html>"
