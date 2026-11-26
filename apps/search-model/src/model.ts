/**
 * The model search embeds with (ADR 0014), named in the shared config so the facilitator knows it
 * too. The image fetches its files at this revision, and the server names its vectors with
 * `MODEL_ID`, so a vector says which model made it.
 */
export {
  SEARCH_MODEL_ID as MODEL_ID,
  SEARCH_MODEL_REPO as MODEL_REPO,
  SEARCH_MODEL_REVISION as MODEL_REVISION,
} from "@stellar-x402/config";
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
