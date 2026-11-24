export type TokenKind = "keyword" | "string" | "comment" | "mark";
export interface Token {
  text: string;
  kind?: TokenKind;
}

const JS = /(\/\/[^\n]*)|("(?:[^"\\\n]|\\.)*"|`[^`]*`)|\b(import|from|const|new|async|await)\b/g;
const JSON_KEYS = /(\/\/[^\n]*)|("(?:[^"\\\n]|\\.)*")(?=\s*:)/g;

/**
 * Splits a snippet into coloured parts. It is not a parser: it knows the comments, strings and
 * keywords the page's own snippets use, and for JSON only the keys. A string in `mark` gets the
 * accent colour. The parts always join back to `source`.
 */
export function tokenize(source: string, language: "js" | "json", mark: string[] = []): Token[] {
  const tokens: Token[] = [];
  let last = 0;
  for (const match of source.matchAll(language === "js" ? JS : JSON_KEYS)) {
    if (match.index > last) tokens.push({ text: source.slice(last, match.index) });
    const text = match[0];
    let kind: TokenKind;
    if (match[1]) kind = "comment";
    else if (language === "json" || mark.includes(text)) kind = "mark";
    else kind = match[2] ? "string" : "keyword";
    tokens.push({ text, kind });
    last = match.index + text.length;
  }
  if (last < source.length) tokens.push({ text: source.slice(last) });
  return tokens;
}

export function Code(props: { source: string; language: "js" | "json"; mark?: string[] }) {
  return (
    <pre>
      {tokenize(props.source, props.language, props.mark).map((token, i) =>
        token.kind ? (
          <span key={i} className={`tok-${token.kind}`}>
            {token.text}
          </span>
        ) : (
          token.text
        ),
      )}
    </pre>
  );
}
