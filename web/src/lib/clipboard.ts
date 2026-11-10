export async function copyPlain(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(text); return true; } catch { /* blocked — fall through */ }
  }
  const ta = document.createElement("textarea");
  ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
  document.body.appendChild(ta); ta.focus(); ta.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch { ok = false; }
  document.body.removeChild(ta);
  return ok;
}

export async function copyRich(html: string, plain: string): Promise<boolean> {
  if (navigator.clipboard?.write && typeof ClipboardItem !== "undefined") {
    try {
      await navigator.clipboard.write([new ClipboardItem({
        "text/html": new Blob([html], { type: "text/html" }),
        "text/plain": new Blob([plain], { type: "text/plain" }),
      })]);
      return true;
    } catch { /* blocked — fall through */ }
  }
  const div = document.createElement("div");
  div.innerHTML = html; div.style.position = "fixed"; div.style.opacity = "0"; div.style.pointerEvents = "none";
  document.body.appendChild(div);
  const sel = window.getSelection();
  const range = document.createRange(); range.selectNodeContents(div);
  sel?.removeAllRanges(); sel?.addRange(range);
  let ok = false;
  try { ok = document.execCommand("copy"); } catch { ok = false; }
  sel?.removeAllRanges();
  document.body.removeChild(div);
  return ok;
}
