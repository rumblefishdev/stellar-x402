"""Embed listings (and later queries) with one ONNX model. Pooling and prefixes per model card."""
import json, sys, time, resource
import numpy as np, onnxruntime as ort
from tokenizers import Tokenizer

MODELS = {
    "minilm": {"dir": "all-MiniLM-L6-v2", "pool": "mean", "max": 256, "qprefix": ""},
    "bge": {"dir": "bge-small-en-v1.5", "pool": "cls", "max": 512,
            "qprefix": "Represent this sentence for searching relevant passages: "},
    "gte": {"dir": "gte-small", "pool": "mean", "max": 512, "qprefix": ""},
    "arctic": {"dir": "arctic-embed-s", "pool": "cls", "max": 512,
               "qprefix": "Represent this sentence for searching relevant passages: "},
    "e5": {"dir": "e5-small-v2", "pool": "mean", "max": 512, "qprefix": "query: ", "pprefix": "passage: "},
    "granite": {"dir": "granite-30m", "pool": "cls", "max": 512, "qprefix": ""},
    "bgebase": {"dir": "bge-base-en-v1.5", "pool": "cls", "max": 512,
                "qprefix": "Represent this sentence for searching relevant passages: "},
}

class Model:
    def __init__(self, base, name):
        m = MODELS[name]
        self.m = m
        self.tok = Tokenizer.from_file(f"{base}/models/{m['dir']}/tokenizer.json")
        self.tok.enable_truncation(m["max"])
        self.tok.enable_padding()
        so = ort.SessionOptions(); so.intra_op_num_threads = 1  # the server gives the model 1 CPU
        self.sess = ort.InferenceSession(f"{base}/models/{m['dir']}/onnx/model.onnx", so)
        self.inputs = {i.name for i in self.sess.get_inputs()}

    def embed(self, texts, query=False):
        if query and self.m["qprefix"]:
            texts = [self.m["qprefix"] + t for t in texts]
        if not query and self.m.get("pprefix"):
            texts = [self.m["pprefix"] + t for t in texts]
        enc = self.tok.encode_batch(texts)
        ids = np.array([e.ids for e in enc], dtype=np.int64)
        mask = np.array([e.attention_mask for e in enc], dtype=np.int64)
        feed = {"input_ids": ids, "attention_mask": mask}
        if "token_type_ids" in self.inputs:
            feed["token_type_ids"] = np.zeros_like(ids)
        out = self.sess.run(None, feed)[0]
        if self.m["pool"] == "cls":
            v = out[:, 0]
        else:
            v = (out * mask[..., None]).sum(1) / mask.sum(1, keepdims=True)
        return v / np.linalg.norm(v, axis=1, keepdims=True)

if __name__ == "__main__":
    base, name = sys.argv[1], sys.argv[2]
    rows = [json.loads(l) for l in open(f"{base}/data/listings.jsonl")]
    t0 = time.time(); model = Model(base, name); load = time.time() - t0
    t0 = time.time()
    vecs = np.concatenate([model.embed([r["text"] for r in rows[i:i+32]]) for i in range(0, len(rows), 32)])
    np.save(f"{base}/data/vec_{name}.npy", vecs.astype(np.float32))
    rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1e6  # bytes on macOS
    print(json.dumps({"model": name, "load_s": round(load, 2), "listings_s": round(time.time() - t0, 1),
                      "per_listing_ms": round((time.time() - t0) / len(rows) * 1000, 1), "max_rss_mb": round(rss)}))
