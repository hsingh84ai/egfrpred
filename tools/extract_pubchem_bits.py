#!/usr/bin/env python3
"""Recover the 881 PubChem fingerprint bit definitions from CDK 1.4.6 bytecode.

The browser port needs to reproduce PaDEL's fingerprint exactly, and PaDEL just
delegates to CDK's PubchemFingerprinter. Rather than transcribe 881 bit
definitions by hand from the PubChem spec (and hope CDK agrees with it), this
reads them straight out of the shipped jar.

CDK compiles all three sections into long, perfectly regular instruction
sequences, so a small bytecode scraper recovers them exactly:

    countElements       bits   0-114   >= N atoms of element E
    countRings          bits 115-262   >= N SSSR rings matching a predicate
    countSubstructures  bits 263-880   >= N matches of a SMARTS pattern

Usage:  python3 tools/extract_pubchem_bits.py [--jar lib/cdk-1.4.6.jar]

Writes app/src/lib/fingerprint/bits.json. Requires `javap` (any JDK).
"""

import argparse
import json
import pathlib
import re
import shutil
import subprocess
import tempfile
import zipfile

CLASS = "org.openscience.cdk.fingerprint.PubchemFingerprinter"

# Each section is emitted as its own private static method.
SECTIONS = {
    "countElements": (0, 114),
    "countRings": (115, 262),
    "countSubstructures": (263, 880),
}

# `bipush 7` / `sipush 300` / `iconst_3` all push a small int.
PUSH = re.compile(r"\d+: (?:iconst_(\d)|(?:sipush|bipush)\s+(\d+))$")
# Constants past pool index 255 use ldc_w, so both spellings must be accepted --
# missing this silently truncates the table at bit 388.
LDC = re.compile(r"ldc(?:_w)?\s+#\d+\s+// String (.*)$")


def push_value(line):
    m = PUSH.match(line)
    if not m:
        return None
    return int(m.group(1) if m.group(1) is not None else m.group(2))


def disassemble(jar):
    """javap the fingerprinter, returning its output split into lines."""
    with tempfile.TemporaryDirectory() as tmp:
        with zipfile.ZipFile(jar) as z:
            for name in z.namelist():
                if "PubchemFingerprinter" in name and name.endswith(".class"):
                    z.extract(name, tmp)
        out = subprocess.run(
            ["javap", "-p", "-c", "-constants", "-cp", tmp, CLASS],
            capture_output=True, text=True, check=True,
        )
    return out.stdout.split("\n")


def split_methods(lines):
    """Slice the disassembly into one line-range per method body."""
    # Method headers sit at two-space indent and carry a parameter list; some
    # also trail a `throws` clause, so match on the parens rather than the tail.
    heads = [i for i, l in enumerate(lines) if re.match(r"^  \S.*\(.*\).*;$", l)]
    bodies = {}
    for start, end in zip(heads, heads[1:] + [len(lines)]):
        for name in SECTIONS:
            if re.search(rf"\b{name}\(", lines[start]):
                bodies[name] = [l.strip() for l in lines[start:end]]
    return bodies


def scrape(body, call_re, slot, threshold_op):
    """Walk one method body, pairing each bit number with its test.

    The compiler emits, per bit: push the bit number, store it to a local, push
    the call arguments, invoke the counter, then branch on the result. Tracking
    (last bit number, pushed args, invoked method) across the stream recovers
    every bit; the branch operand gives the threshold, defaulting to 1 for the
    `ifle` (i.e. "> 0") form.
    """
    bits, cur, args, text = {}, None, [], None
    for i, line in enumerate(body):
        n = push_value(line)
        if n is not None:
            # `push N; istore_<slot>` is the bit-number assignment; any other
            # push is an argument to the upcoming counter call.
            if i + 1 < len(body) and body[i + 1].endswith(f"istore_{slot}"):
                cur, args = n, []
            else:
                args.append(n)
            continue
        m = LDC.search(line)
        if m:
            text = m.group(1)
            continue
        m = call_re.search(line)
        if m and cur is not None:
            look = " ".join(body[i + 1:i + 3])
            t = re.search(rf"(?:iconst_|sipush\s+|bipush\s+)(\d+)\s+\d+: {threshold_op}", look)
            bits[cur] = (m.group(1), text, args, int(t.group(1)) if t else 1, line)
            text, args = None, []
    return bits


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--jar", default="lib/cdk-1.4.6.jar")
    ap.add_argument("--out", default="app/src/lib/fingerprint/bits.json")
    args = ap.parse_args()

    if not shutil.which("javap"):
        raise SystemExit("javap not found -- install a JDK")

    bodies = split_methods(disassemble(args.jar))
    missing = set(SECTIONS) - set(bodies)
    if missing:
        raise SystemExit(f"could not locate method(s): {sorted(missing)}")

    table = {}

    # Section 1: getCount("H") >= 16 and friends. Threshold branch is if_icmplt.
    call = re.compile(r"// Method \S*CountElements\.(getCount):")
    for bit, (_, element, _, thr, _l) in scrape(bodies["countElements"], call, 2, "if_icmplt").items():
        table[bit] = {"kind": "element", "element": element, "min": thr}

    # Section 2: countAnyRing(3) >= 1 and friends. Most predicates take a ring
    # size; countAromaticRing/countHeteroAromaticRing are nullary and count
    # matching rings of *any* size, so read the arity off the descriptor rather
    # than assuming a trailing push belongs to this call.
    call = re.compile(r"// Method \S*CountRings\.(\w+):")
    for bit, (name, _, argv, thr, line) in scrape(bodies["countRings"], call, 3, "if_icmplt").items():
        sized = not re.search(rf"{name}:\(\)", line)
        table[bit] = {"kind": "ring", "predicate": name,
                      "size": argv[-1] if sized else None, "min": thr}

    # Section 3-7: countSubstructure("[Li&!H0]") > 0. Presence tests use ifle.
    call = re.compile(r"// Method \S*CountSubstructures\.(countSubstructure):")
    for bit, (_, smarts, _, thr, _l) in scrape(bodies["countSubstructures"], call, 3, "if_icmple").items():
        table[bit] = {"kind": "smarts", "smarts": smarts, "min": thr}

    for name, (lo, hi) in SECTIONS.items():
        gaps = [b for b in range(lo, hi + 1) if b not in table]
        if gaps:
            raise SystemExit(f"{name}: {len(gaps)} bits unrecovered, e.g. {gaps[:10]}")

    out = pathlib.Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({str(k): table[k] for k in sorted(table)}, indent=1) + "\n")
    print(f"recovered all {len(table)} bits -> {out}")


if __name__ == "__main__":
    main()
