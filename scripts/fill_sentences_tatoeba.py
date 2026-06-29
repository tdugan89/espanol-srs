#!/usr/bin/env python3
"""
Fill missing example sentences from the Tatoeba corpus.

Downloads Spanish and English sentences + translation links from Tatoeba,
then patches occurrences that have no usable text_es in content-v2/ and
in app_data_v2.json in one pass.

Usage:
    python3 scripts/fill_sentences_tatoeba.py
"""

import json, re, os, bz2, tarfile, urllib.request, unicodedata, sys
from collections import defaultdict
from pathlib import Path

REPO    = Path(__file__).resolve().parent.parent
CONTENT = REPO / "content-v2"
CACHE   = Path("/private/tmp/tatoeba-cache")
CACHE.mkdir(parents=True, exist_ok=True)

# ── Download helpers ──────────────────────────────────────────────────────────

BASE = "https://downloads.tatoeba.org/exports"

def dl(url, dest, label):
    dest = Path(dest)
    if dest.exists():
        print(f"  cached  {label}  ({dest.stat().st_size // 1024:,} KB)")
        return
    print(f"  downloading {label} …", flush=True)
    part = str(dest) + ".part"
    urllib.request.urlretrieve(url, part)
    os.rename(part, dest)
    print(f"  saved {dest.stat().st_size // 1024:,} KB")

SPA_BZ2   = CACHE / "spa_sentences.tsv.bz2"
ENG_BZ2   = CACHE / "eng_sentences.tsv.bz2"
LINKS_BZ2 = CACHE / "links.tar.bz2"

dl(f"{BASE}/per_language/spa/spa_sentences.tsv.bz2", SPA_BZ2, "Spanish sentences")
dl(f"{BASE}/per_language/eng/eng_sentences.tsv.bz2", ENG_BZ2, "English sentences")
dl(f"{BASE}/links.tar.bz2",                          LINKS_BZ2, "translation links")

# ── Load sentences ────────────────────────────────────────────────────────────

print("\nLoading Spanish sentences …", flush=True)
spa_by_id = {}
with bz2.open(SPA_BZ2, "rt", encoding="utf-8") as f:
    for line in f:
        parts = line.rstrip("\n").split("\t")
        if len(parts) >= 3:
            spa_by_id[parts[0]] = parts[2]
print(f"  {len(spa_by_id):,} sentences")

print("Loading English sentences …", flush=True)
eng_by_id = {}
with bz2.open(ENG_BZ2, "rt", encoding="utf-8") as f:
    for line in f:
        parts = line.rstrip("\n").split("\t")
        if len(parts) >= 3:
            eng_by_id[parts[0]] = parts[2]
print(f"  {len(eng_by_id):,} sentences")

print("Loading translation links …", flush=True)
spa_ids = set(spa_by_id)
eng_ids = set(eng_by_id)
spa_to_eng = {}
with tarfile.open(LINKS_BZ2, "r:bz2") as tar:
    member = tar.getmembers()[0]
    fobj = tar.extractfile(member)
    assert fobj is not None
    for raw in fobj:
        parts = raw.decode("utf-8").rstrip("\n").split("\t")
        if len(parts) < 2:
            continue
        a, b = parts[0], parts[1]
        if a in spa_ids and b in eng_ids:
            spa_to_eng.setdefault(a, []).append(b)
        elif b in spa_ids and a in eng_ids:
            spa_to_eng.setdefault(b, []).append(a)
print(f"  {len(spa_to_eng):,} Spanish sentences with English translations")

# ── Build word index (normalised → sentence IDs) ──────────────────────────────

def normalise(text: str) -> str:
    return "".join(
        c for c in unicodedata.normalize("NFD", text.casefold())
        if unicodedata.category(c) != "Mn"
    )

print("\nBuilding word index …", flush=True)
word_index = defaultdict(set)
for sid, text in spa_by_id.items():
    for w in re.findall(r"[a-z]+", normalise(text)):
        word_index[w].add(sid)
sorted_words = sorted(word_index)   # for stem bisect lookups
print(f"  {len(word_index):,} unique normalised tokens")

# ── Matching ──────────────────────────────────────────────────────────────────

BAD = re.compile(r"^\d|^[Nn]úmero", re.I)

def score_sentence(spa_id: str):
    text = spa_by_id[spa_id]
    if BAD.search(text):
        return None
    l = len(text)
    return l if 20 <= l <= 110 else None

def candidates_for_parts(parts: list[str]) -> list[tuple[int, str]]:
    sets = [word_index.get(p, set()) for p in parts]
    if not all(sets):
        return []
    common = sets[0].copy()
    for s in sets[1:]:
        common &= s
    out = []
    for sid in common:
        s = score_sentence(sid)
        if s is not None:
            out.append((s, sid))
    return out

def stem_candidates(stem: str) -> list[tuple[int, str]]:
    import bisect
    lo = bisect.bisect_left(sorted_words, stem)
    out = []
    for w in sorted_words[lo:]:
        if not w.startswith(stem):
            break
        for sid in word_index[w]:
            s = score_sentence(sid)
            if s is not None:
                out.append((s, sid))
    return out

def find_match(word: str):
    """Return (text_es, text_en, tatoeba_id) or ('', '', None)."""
    parts = re.findall(r"[a-z]+", normalise(word))
    if not parts:
        return "", "", None

    cands = candidates_for_parts(parts)

    # Stem fallback for single words > 5 chars (catches conjugations)
    if not cands and len(parts) == 1 and len(parts[0]) > 5:
        cands = stem_candidates(parts[0][:5])

    if not cands:
        return "", "", None

    cands.sort()
    best_id = cands[0][1]
    spa_text = spa_by_id[best_id]
    eng_ids  = spa_to_eng.get(best_id, [])
    eng_text = eng_by_id[eng_ids[0]] if eng_ids else ""
    return spa_text, eng_text, best_id

# ── Identify missing cards ─────────────────────────────────────────────────────

print("\nLoading content …")
with open(CONTENT / "occurrences.json") as f:
    occurrences = json.load(f)
with open(CONTENT / "cards.json") as f:
    cards = json.load(f)
with open(CONTENT / "lexemes.json") as f:
    lexemes_list = json.load(f)
lexemes = {l["id"]: l for l in lexemes_list}

occ_by_id = {o["id"]: o for o in occurrences}

_NUMERO = re.compile(r"^[Nn]úmero\s+\w+[.,]?\s*")

def clean_fsi(text: str) -> str:
    if not text:
        return ""
    cleaned = _NUMERO.sub("", text).strip()
    return "" if re.search(r"[Nn]úmero\s+\w", cleaned) else cleaned

missing = []
for c in cards:
    occ_id = c["example_occurrence_ids"][0] if c["example_occurrence_ids"] else None
    occ    = occ_by_id.get(occ_id) if occ_id else None
    if not clean_fsi(occ["text_es"] if occ else ""):
        lex = lexemes.get(c["lexeme_id"], {})
        missing.append({
            "card_id":  c["id"],
            "lexeme_id": c["lexeme_id"],
            "occ_id":   occ_id,
            "prompt":   c["prompt"],
            "pos":      lex.get("part_of_speech", ""),
        })

print(f"Cards needing sentences: {len(missing)}")

# ── Match and patch ───────────────────────────────────────────────────────────

filled, unmatched = 0, []

for m in missing:
    spa_text, eng_text, tatoeba_id = find_match(m["prompt"])
    if spa_text:
        occ = occ_by_id[m["occ_id"]]
        occ["text_es"] = spa_text
        occ["text_en"] = eng_text
        occ["source"]  = {"kind": "tatoeba", "tatoeba_id": tatoeba_id}
        filled += 1
    else:
        unmatched.append(m["prompt"])

print(f"\nFilled:    {filled}")
print(f"Unmatched: {len(unmatched)}")
if unmatched:
    print("  " + ", ".join(unmatched[:30]))

# ── Write content-v2/occurrences.json ────────────────────────────────────────

print("\nWriting content-v2/occurrences.json …")
with open(CONTENT / "occurrences.json", "w") as f:
    json.dump(occurrences, f, ensure_ascii=False, indent=2)

# ── Patch app_data_v2.json in place ──────────────────────────────────────────

print("Patching app_data_v2.json …")
bundle_path = REPO / "app_data_v2.json"
with open(bundle_path) as f:
    bundle = json.load(f)

bundle_occs = bundle["entities"]["occurrences"]
bundle_occ_idx = {o["id"]: i for i, o in enumerate(bundle_occs)}

patched = 0
for m in missing:
    occ = occ_by_id.get(m["occ_id"])
    if occ and isinstance(occ.get("source"), dict) and occ["source"].get("kind") == "tatoeba":
        idx = bundle_occ_idx.get(m["occ_id"])
        if idx is not None:
            bundle_occs[idx]["text_es"] = occ["text_es"]
            bundle_occs[idx]["text_en"] = occ["text_en"]
            patched += 1

print(f"Patched {patched} occurrences in bundle")

with open(bundle_path, "w") as f:
    json.dump(bundle, f, ensure_ascii=False)

print("\nDone. Commit app_data_v2.json + content-v2/occurrences.json.")
