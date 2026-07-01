/**
 * HTML ⇄ HTML normalization between TipTap's serialization and the canonical
 * stored format the native `react-native-enriched` editor reads/writes.
 *
 * This is NOT a markdown translation — both sides are the same rich-text HTML
 * family; markdown is only a live typing transform inside the editor. The only
 * shaping needed is (a) the checkbox-list dialect (TipTap emits
 * `<ul data-type="taskList">` / `<li data-type="taskItem" data-checked>`; native
 * wants `<ul data-type="checkbox">` / `<li checked>`), (b) stripping the `<p>`
 * TipTap wraps list items in, and (c) the `<html>…</html>` wrapper native needs.
 * The transforms mirror the enriched library's own web normalizers, so a
 * web-edited body renders identically on mobile.
 *
 * Web-only: leans on the browser DOM; imported solely from `*.web` files.
 */

/** Stored native HTML → the HTML TipTap should parse when seeding the editor. */
export function storedHtmlToTiptap(html: string): string {
  if (!html || !html.trim()) return '';
  const doc = new DOMParser().parseFromString(html, 'text/html');

  // Native checkbox list → TipTap task list. Wrap each item's inline content in
  // a <p> (TipTap task items hold a paragraph) and map `checked` → `data-checked`.
  doc.querySelectorAll('ul[data-type="checkbox"]').forEach((ul) => {
    ul.setAttribute('data-type', 'taskList');
    ul.querySelectorAll('li').forEach((li) => {
      li.setAttribute('data-type', 'taskItem');
      if (li.hasAttribute('checked')) {
        li.setAttribute('data-checked', 'true');
        li.removeAttribute('checked');
      } else {
        li.setAttribute('data-checked', 'false');
      }
      li.innerHTML = `<p>${li.innerHTML}</p>`;
    });
  });

  // Native blank lines are <br>; TipTap represents them as empty paragraphs.
  return doc.body.innerHTML.replace(/<br\s*\/?>/gi, '<p></p>');
}

/** TipTap's `editor.getHTML()` → the canonical stored/synced native HTML body. */
export function tiptapHtmlToStored(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');

  // TipTap task list → native checkbox list, flattening the item back to its
  // inline content (drop the <label><input> UI and the wrapping <div><p>).
  doc.querySelectorAll('ul[data-type="taskList"]').forEach((ul) => {
    ul.setAttribute('data-type', 'checkbox');
    ul.querySelectorAll('li[data-type="taskItem"]').forEach((li) => {
      if (li.getAttribute('data-checked') === 'true') li.setAttribute('checked', '');
      li.removeAttribute('data-type');
      li.removeAttribute('data-checked');
      const p = li.querySelector('div > p') ?? li.querySelector('p');
      li.innerHTML = p ? p.innerHTML : (li.textContent ?? '');
    });
  });

  let out = doc.body.innerHTML;
  // Bullet/ordered items: strip the <p> wrapper native doesn't use.
  out = out.replace(/<li([^>]*)><p>(.*?)<\/p><\/li>/gs, '<li$1>$2</li>');
  out = out.replace(/checked=""/g, 'checked');
  out = out.replace(/<p><\/p>/g, '<br>');

  // Empty body (no text and no structural content) stores as '' — an empty note
  // has an empty body, not an empty <html> wrapper.
  const text = out.replace(/<br\s*\/?>/gi, '').replace(/<[^>]+>/g, '').trim();
  if (!text && !/<(ul|ol|img|hr)\b/i.test(out)) return '';

  return `<html>${out}</html>`;
}
