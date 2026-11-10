"""Line-based three-way merge for the Drafting view's manuscript saves."""

import difflib


def _opcodes(base, side):
    """Changed regions of `side` against `base`, as (b_lo, b_hi, s_lo, s_hi)."""
    sm = difflib.SequenceMatcher(a=base, b=side, autojunk=False)
    return [(i1, i2, j1, j2) for tag, i1, i2, j1, j2 in sm.get_opcodes() if tag != "equal"]


def _overlaps(a, b):
    """Do two base ranges contend for the same lines?"""
    a_lo, a_hi, b_lo, b_hi = a[0], a[1], b[0], b[1]
    if a_lo == a_hi and b_lo == b_hi:
        return a_lo == b_lo
    return a_lo < b_hi and b_lo < a_hi


def merge_lines(base, mine, theirs):
    """(merged_lines, conflicted) — a diff3 over three line lists."""
    mine_ops, their_ops = _opcodes(base, mine), _opcodes(base, theirs)

    # pair up every region either side touched, coalescing any that overlap in base
    regions = []
    for lo, hi, s_lo, s_hi in mine_ops:
        regions.append([lo, hi, [(s_lo, s_hi)], []])
    for lo, hi, s_lo, s_hi in their_ops:
        regions.append([lo, hi, [], [(s_lo, s_hi)]])
    regions.sort(key=lambda r: (r[0], r[1]))

    merged_regions = []
    for r in regions:
        if merged_regions and _overlaps(merged_regions[-1], r):
            prev = merged_regions[-1]
            prev[1] = max(prev[1], r[1])
            prev[2] += r[2]
            prev[3] += r[3]
        else:
            merged_regions.append(list(r))

    out, pos = [], 0
    for lo, hi, m_spans, t_spans in merged_regions:
        if lo > pos:
            out.extend(base[pos:lo])
        m_text = mine[min(s[0] for s in m_spans):max(s[1] for s in m_spans)] if m_spans else None
        t_text = theirs[min(s[0] for s in t_spans):max(s[1] for s in t_spans)] if t_spans else None
        if m_text is None:
            out.extend(t_text)
        elif t_text is None:
            out.extend(m_text)
        elif m_text == t_text:
            out.extend(m_text)          # both made the same change
        else:
            return ([], True)
        pos = max(pos, hi)
    out.extend(base[pos:])
    return (out, False)


def merge_text(base, mine, theirs):
    """(merged_text, conflicted) over three whole documents."""
    if mine == theirs:
        return (mine, False)
    if base == mine:
        return (theirs, False)          # we changed nothing; theirs is simply newer
    if base == theirs:
        return (mine, False)            # they changed nothing since our base
    merged, conflicted = merge_lines(
        (base or "").splitlines(keepends=True),
        (mine or "").splitlines(keepends=True),
        (theirs or "").splitlines(keepends=True))
    if conflicted:
        return ("", True)
    return ("".join(merged), False)
