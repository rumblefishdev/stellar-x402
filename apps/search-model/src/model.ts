/**
 * The model search embeds with (ADR 0014), pinned by its revision. The image fetches these files
 * at this revision when it is built, and the server names its vectors with `MODEL_ID`, so a
 * vector says which model made it.
 */
export const MODEL_REPO = "ibm-granite/granite-embedding-30m-english";
export const MODEL_REVISION = "9b5b096411652ec1189c68fcfb90d0a82c5b45af";
export const MODEL_ID = `${MODEL_REPO}@${MODEL_REVISION}`;
/** What the server reads: the ONNX graph and the tokenizer that matches it. */
export const MODEL_FILES = ["model.onnx", "tokenizer.json", "tokenizer_config.json"];
