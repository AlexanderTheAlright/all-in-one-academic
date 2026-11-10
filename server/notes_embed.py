#!/usr/bin/env python3
import argparse
import hashlib
import json
import sys
import urllib.request
from pathlib import Path

import settings

OLLAMA = "http://localhost:11434/api/embeddings"
MODEL = "nomic-embed-text"
CACHE_NAME = ".notes-vectors.json"


def embed(text, model, url):
    body = json.dumps({"model": model, "prompt": text}).encode("utf-8")
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())["embedding"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--vault", default=str(settings.VAULT))
    ap.add_argument("--out", action="append", default=[])
    ap.add_argument("--model", default=MODEL)
    ap.add_argument("--url", default=OLLAMA)
    args = ap.parse_args()

    here = Path(__file__).resolve().parent
    outs = [Path(o) for o in args.out] or [settings.STATE_DIR / CACHE_NAME]

    # reuse notes_organizer for note enumeration + body reading, pointed at the vault
    sys.path.insert(0, str(here))
    import notes_organizer as no
    vault = Path(args.vault)
    no.VAULT = vault
    no.NOTES = vault / "Preparation" / "Notes"
    no.INBOX = no.NOTES / "Inbox"

    # load an existing cache (from the first out that has one) for incremental re-embed
    prev = {}
    for o in outs:
        if o.exists():
            try:
                prev = json.loads(o.read_text(encoding="utf-8")).get("notes", {})
                break
            except (OSError, ValueError):
                prev = {}

    nodes = no.note_nodes()
    out_notes = {}
    fresh = 0
    for n in nodes:
        nid = n["id"]
        try:
            _, body = no._split_frontmatter((vault / n["path"]).read_text(encoding="utf-8"))
        except OSError:
            body = ""
        text = f"{n['title']}\n{' '.join(n.get('tags', []))}\n{body}".strip()[:4000]
        h = hashlib.sha1(text.encode("utf-8")).hexdigest()
        old = prev.get(nid)
        if old and old.get("hash") == h and old.get("vec"):
            out_notes[nid] = old
            continue
        try:
            vec = embed(text, args.model, args.url)
        except Exception as e:  # noqa: BLE001
            print(f"  ! embed failed for {n['title']}: {e}", file=sys.stderr)
            if old:
                out_notes[nid] = old
            continue
        out_notes[nid] = {
            "hash": h, "vec": vec, "title": n["title"], "path": n["path"],
            "type": n["type"], "tags": n.get("tags", []),
        }
        fresh += 1

    dim = len(next(iter(out_notes.values()))["vec"]) if out_notes else 0
    payload = {"version": 1, "model": args.model, "dim": dim, "notes": out_notes}
    blob = json.dumps(payload)
    for o in outs:
        try:
            o.write_text(blob, encoding="utf-8")
            print(f"wrote {len(out_notes)} vectors (dim {dim}, {fresh} new) -> {o}")
        except OSError as e:
            print(f"  ! could not write {o}: {e}", file=sys.stderr)


if __name__ == "__main__":
    main()
