#!/usr/bin/env python3
"""Convert the legacy scikit-learn 0.15.2 pickle into portable JSON.

The shipped `model` file can only be unpickled by scikit-learn 0.15.2 on Python
2.7 -- newer versions raise `TypeError: __cinit__() takes exactly 6 positional
arguments` because the Cython Tree constructor changed. But nothing about the
*data* is version specific: a fitted random forest is just arrays. Substituting
stub classes for every `sklearn.*` symbol lets a modern Python read the pickle
without scikit-learn installed at all, after which the trees are plain numpy.

Two properties make the exported form very small:
  * every split threshold is 0.5, because all 49 inputs are binary fingerprint
    bits -- so traversal is `node = bit ? right : left`, no thresholds needed;
  * only the positive-class probability of each leaf is ever used.

Usage:  python3 tools/export_model.py [--model model] [--indices imp-no]
"""

import argparse
import json
import pathlib
import pickle

import numpy as np

# The Python 2 pipeline reads column `z` of the PaDEL output for each index in
# `imp-no`, where column 0 is the molecule name -- so index z means PubchemFP
# (z - 1). It then slices the first 49 of the 50 listed indices to match the
# model's input width, silently dropping the last one.
NAME_COLUMN_OFFSET = 1


def stub(module, name):
    """A stand-in for an sklearn class that just captures its unpickled state."""
    class Stub:
        def __init__(self, *args, **kwargs):
            self.args = args
        def __setstate__(self, state):
            self.state = state
    Stub.__name__ = name
    return Stub


class StubUnpickler(pickle.Unpickler):
    def find_class(self, module, name):
        if module.startswith("sklearn"):
            return stub(module, name)
        return super().find_class(module, name)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="model")
    ap.add_argument("--indices", default="imp-no")
    ap.add_argument("--out", default="app/src/lib/model/forest.json")
    args = ap.parse_args()

    with open(args.model, "rb") as fh:
        forest = StubUnpickler(fh, encoding="latin1").load().state

    n_features = forest["n_features_"]
    columns = [int(line) for line in open(args.indices) if line.strip()]
    if len(columns) > n_features:
        print(f"note: {args.indices} lists {len(columns)} indices but the model takes "
              f"{n_features}; keeping the first {n_features}, as the original does")
        columns = columns[:n_features]
    bits = [c - NAME_COLUMN_OFFSET for c in columns]

    trees = []
    for estimator in forest["estimators_"]:
        tree = estimator.state["tree_"].state
        feature = tree["feature"]
        threshold = tree["threshold"]
        left, right = tree["children_left"], tree["children_right"]

        internal = feature >= 0
        odd = sorted(set(threshold[internal]) - {0.5})
        if odd:
            raise SystemExit(f"expected every split at 0.5 on binary inputs, saw {odd}")

        # value is (n_nodes, n_outputs, n_classes) flattened; classes are [-1, 1]
        # and only P(class=1) matters downstream.
        counts = np.asarray(tree["value"], dtype=float).reshape(-1, 2)
        totals = counts.sum(axis=1)
        proba = np.divide(counts[:, 1], totals, out=np.zeros(len(totals)), where=totals > 0)
        if (totals[~internal] <= 0).any():
            raise SystemExit("a leaf carries no samples; cannot derive its probability")

        trees.append({
            "l": left.tolist(),
            "r": right.tolist(),
            "f": feature.tolist(),
            # Leaves are the only nodes whose probability is read; rounding to
            # 6dp keeps the file small and is far below the 0.20 decision margin.
            "p": [round(float(p), 6) for p in proba],
        })

    out = pathlib.Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({
        "bits": bits,
        "classes": [int(c) for c in forest["classes_"]],
        "threshold": 0.20,
        "trees": trees,
    }, separators=(",", ":")) + "\n")

    nodes = sum(len(t["f"]) for t in trees)
    print(f"exported {len(trees)} trees / {nodes} nodes over {len(bits)} bits "
          f"-> {out} ({out.stat().st_size / 1024:.0f} KB)")


if __name__ == "__main__":
    main()
