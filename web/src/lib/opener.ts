/** An action on the app's own server: a POST whose JSON body carries what the path's
 *  query string names, plus `extra`. */
export function act(path: string, extra?: Record<string, unknown>): Promise<Response> {
  const cut = path.indexOf("?");
  const body: Record<string, unknown> = {};
  if (cut >= 0) new URLSearchParams(path.slice(cut + 1)).forEach((v, k) => { body[k] = v; });
  return fetch(cut >= 0 ? path.slice(0, cut) : path, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, ...extra }),
  });
}

export async function openFile(file: string): Promise<void> {
  await act("/open", { file }).catch(() => {});
}

/** an external link in this machine's default browser */
export async function openUrl(url: string): Promise<void> {
  await act("/open-url", { url }).catch(() => {});
}

/** the `o` key: the file (and its pair) in Obsidian. `dry` plans only. */
export async function openObsidian(q: URLSearchParams): Promise<unknown> {
  const body: Record<string, string> = {};
  q.forEach((v, k) => { body[k] = v; });
  return act("/obsidian/open", body).then((r) => r.json()).catch(() => null);
}

/** the audience page as its own browser window, here */
export async function openPresent(slug: string, deck: string): Promise<{ ok: boolean }> {
  const r = await fetch("/present/open", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slug, deck }),
  });
  return r.json();
}

export async function openResolved<T extends { ok?: boolean; error?: string }>(path: string): Promise<T> {
  return act(path).then((r) => r.json() as Promise<T>);
}

export type OpenDirResult = { ok?: boolean; error?: string; missing?: boolean };

export async function openDir(which: "project" | "writing", slug: string): Promise<OpenDirResult> {
  const path = `/drafting/open-dir?which=${which}&slug=${encodeURIComponent(slug)}`;
  return act(path).then((r) => r.json()).catch(() => ({ ok: false, error: "The server did not answer" }));
}
