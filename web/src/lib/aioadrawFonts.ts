
import { FONTS, clearTextCache, fontFaceCss } from "@/lib/aioadraw";
import type { FontId } from "@/lib/aioadraw";

let ready: Promise<void> | null = null;
export function loadFonts(): Promise<void> {
  if (!ready) ready = (async () => {
    await Promise.all(Object.values(FONTS).map(async (f) => {
      try {
        const face = new FontFace(f.name, `url(${f.url})`, f.weight ? { weight: f.weight } : {});
        document.fonts.add(await face.load());
        await Promise.all([document.fonts.load(`20px "${f.name}"`), document.fonts.load(`700 20px "${f.name}"`)]);
      } catch { /* the system stack stands in */ }
    }));
    clearTextCache();
  })();
  return ready;
}

const cssP = new Map<FontId, Promise<string>>();
export function fontCss(font: FontId): Promise<string> {
  let p = cssP.get(font);
  if (!p) {
    p = fetch(FONTS[font].url)
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error("font"))))
      .then((b) => new Promise<string>((res, rej) => {
        const fr = new FileReader();
        fr.onload = () => res(String(fr.result));
        fr.onerror = () => rej(new Error("font"));
        fr.readAsDataURL(b);
      }))
      .then((url) => fontFaceCss(font, url))
      .catch(() => { cssP.delete(font); return ""; });
    cssP.set(font, p);
  }
  return p;
}
