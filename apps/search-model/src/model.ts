/**
 * The model search embeds with (ADR 0014), pinned by its revision. The image fetches these files
 * at this revision when it is built, and the server names its vectors with `MODEL_ID`, so a
 * vector says which model made it.
 */
export const MODEL_REPO = "ibm-granite/granite-embedding-30m-english";
export const MODEL_REVISION = "9b5b096411652ec1189c68fcfb90d0a82c5b45af";
export const MODEL_ID = `${MODEL_REPO}@${MODEL_REVISION}`;
/**
 * What the server reads: the ONNX graph and the tokenizer that matches it, each with the SHA-256
 * of its bytes. The revision pins which files are fetched; the hash checks that the bytes fetched
 * are those files. The tokenizer's config is last: the tests take it as the sign all are written.
 */
export const MODEL_FILES = {
  "model.onnx": "3a85876825c5144a646dd4da8d05271e2536774481849e8825102ca2126770fc",
  "tokenizer.json": "33465117406b9007673e8ba283f7f1383d9b5094df947481af60eec94ed7d7bd",
  "tokenizer_config.json": "f2d4b4fc5576ca1e6a594e4917a8cd8848d04b22b7e5303ba383a0e85a22ff8f",
};
