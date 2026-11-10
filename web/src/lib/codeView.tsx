
import { useEffect, useRef } from "react";
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter } from "@codemirror/view";
import { EditorState, type Extension } from "@codemirror/state";
import { StreamLanguage, HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { history, defaultKeymap, historyKeymap } from "@codemirror/commands";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { tags as t } from "@lezer/highlight";
import { python } from "@codemirror/lang-python";
import { json } from "@codemirror/lang-json";
import { yaml } from "@codemirror/lang-yaml";
import { markdown } from "@codemirror/lang-markdown";
import { r } from "@codemirror/legacy-modes/mode/r";
import { julia } from "@codemirror/legacy-modes/mode/julia";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { standardSQL } from "@codemirror/legacy-modes/mode/sql";
import { properties } from "@codemirror/legacy-modes/mode/properties";
import { stex } from "@codemirror/legacy-modes/mode/stex";

const STATA_KEYWORDS = new Set([
  "gen", "generate", "egen", "replace", "drop", "keep", "local", "global", "forvalues", "forval",
  "foreach", "if", "else", "while", "program", "define", "end", "use", "save", "merge", "append",
  "reshape", "collapse", "sort", "gsort", "by", "bysort", "summarize", "sum", "tabulate", "tab",
  "regress", "reg", "logit", "probit", "ologit", "oprobit", "mlogit", "xtreg", "xtlogit", "xtprobit",
  "margins", "predict", "quietly", "qui", "capture", "cap", "noisily", "set", "matrix", "mat",
  "scalar", "display", "di", "list", "describe", "encode", "decode", "label", "format", "sysuse",
  "clear", "version", "return", "ereturn", "syntax", "args", "exit", "mata", "preserve", "restore",
  "tempvar", "tempfile", "tempname", "assert", "count", "levelsof", "estimates", "est", "outreg2",
  "esttab", "putexcel", "graph", "twoway", "histogram", "confirm", "input", "recode", "rename",
  "order", "isid", "duplicates", "cd", "pwd", "log", "cls", "which", "help", "update", "adopath",
  "net", "ssc", "in", "using", "of", "webuse", "do", "run", "break", "continue", "class",
]);

function stataLanguage() {
  return StreamLanguage.define<{ inBlockComment: boolean }>({
    name: "stata",
    startState: () => ({ inBlockComment: false }),
    token(stream, state) {
      if (state.inBlockComment) {
        if (stream.match(/^[^*]*\*\//)) state.inBlockComment = false;
        else stream.skipToEnd();
        return "comment";
      }
      if (stream.sol() && stream.match(/^\s*\*/)) { stream.skipToEnd(); return "comment"; }
      if (stream.eatSpace()) return null;
      if (stream.match("/*")) { state.inBlockComment = true; return "comment"; }
      if (stream.match("//")) { stream.skipToEnd(); return "comment"; }
      if (stream.match(/^`[A-Za-z_][A-Za-z0-9_]*'/)) return "variable-2";        // local macro
      if (stream.match(/^\$\{[A-Za-z_][A-Za-z0-9_]*\}/)) return "variable-2";    // ${global}
      if (stream.match(/^\$[A-Za-z_][A-Za-z0-9_]*/)) return "variable-2";        // $global
      if (stream.match(/^"(?:[^"\\]|\\.)*"/)) return "string";
      if (stream.match(/^-?\d+\.?\d*(?:[eE][-+]?\d+)?/)) return "number";
      if (stream.match(/^[A-Za-z_][A-Za-z0-9_]*/)) {
        return STATA_KEYWORDS.has(stream.current().toLowerCase()) ? "keyword" : null;
      }
      if (stream.match(/^(==|!=|<=|>=|&|\||!|~|\+|-|\*|\/|=|<|>)/)) return "operator";
      stream.next();
      return null;
    },
  });
}

/** lang (from drafting.py's _VIEWER_TEXT_EXTS) -> CM6 language extension. Empty
 * array = plain text, still gets line numbers + monospace but no coloring. */
function languageFor(lang?: string): Extension[] {
  switch (lang) {
    case "python": return [python()];
    case "json": return [json()];
    case "yaml": return [yaml()];
    case "markdown": return [markdown()];
    case "r": return [StreamLanguage.define(r)];
    case "julia": return [StreamLanguage.define(julia)];
    case "sql": return [StreamLanguage.define(standardSQL)];
    case "shell": return [StreamLanguage.define(shell)];
    case "properties": return [StreamLanguage.define(properties)];
    case "latex": return [StreamLanguage.define(stex)];
    case "stata": return [stataLanguage()];
    default: return [];
  }
}

const codeHighlightStyle = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.definitionKeyword, t.operatorKeyword], color: "hsl(var(--code-keyword))", fontWeight: 600 },
  { tag: [t.string, t.special(t.string), t.regexp, t.character, t.docString], color: "hsl(var(--code-string))" },
  { tag: t.escape, color: "hsl(var(--code-string))", fontWeight: 600 },
  { tag: [t.number, t.integer, t.float, t.bool, t.null, t.atom], color: "hsl(var(--code-number))" },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: "hsl(var(--code-comment))", fontStyle: "italic" },
  { tag: [t.function(t.variableName), t.function(t.definition(t.variableName)), t.definition(t.variableName), t.definitionOperator], color: "hsl(var(--code-function))" },
  { tag: [t.propertyName, t.attributeName, t.labelName, t.macroName], color: "hsl(var(--code-property))" },
  { tag: [t.typeName, t.className, t.namespace, t.tagName, t.self], color: "hsl(var(--code-type))" },
  { tag: [t.operator, t.compareOperator, t.logicOperator, t.arithmeticOperator, t.bitwiseOperator, t.updateOperator, t.controlOperator, t.derefOperator, t.punctuation], color: "hsl(var(--code-operator))" },
  { tag: t.special(t.variableName), color: "hsl(var(--code-macro))" },
  { tag: t.variableName, color: "hsl(var(--foreground))" },
  { tag: [t.meta, t.annotation, t.processingInstruction], color: "hsl(var(--code-property) / 0.9)" },
  { tag: t.invalid, color: "hsl(var(--destructive))" },
]);

const codeTheme = EditorView.theme({
  "&": { fontSize: "11.5px", backgroundColor: "transparent", height: "100%" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", lineHeight: "1.6", overflow: "auto" },
  ".cm-content": { padding: "12px 0" },
  ".cm-line": { paddingRight: "16px" },
  ".cm-gutters": { backgroundColor: "transparent", border: "none", color: "hsl(var(--muted-foreground) / 0.55)" },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 12px 0 10px" },
  ".cm-activeLine": { backgroundColor: "hsl(var(--secondary) / 0.35)" },
  ".cm-activeLineGutter": { backgroundColor: "hsl(var(--secondary) / 0.35)", color: "hsl(var(--muted-foreground))" },
  ".cm-panels": { backgroundColor: "hsl(var(--card))", color: "hsl(var(--foreground))", border: "1px solid hsl(var(--border))", fontFamily: "system-ui, sans-serif" },
  ".cm-textfield": { backgroundColor: "hsl(var(--background))", border: "1px solid hsl(var(--border))", borderRadius: "6px", color: "hsl(var(--foreground))" },
  ".cm-button": { backgroundColor: "hsl(var(--secondary))", color: "hsl(var(--foreground))", border: "1px solid hsl(var(--border))", borderRadius: "6px", backgroundImage: "none" },
  ".cm-searchMatch": { backgroundColor: "hsl(var(--primary) / 0.22)", borderRadius: "2px" },
  ".cm-searchMatch-selected": { backgroundColor: "hsl(var(--primary) / 0.38)", outline: "1px solid hsl(var(--primary))", borderRadius: "2px" },
});

export function CodeEdit({ value, onChange, lang, className }: {
  value: string; onChange: (v: string) => void; lang?: string; className?: string;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!hostRef.current) return;
    const state = EditorState.create({
      doc: value,
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        history(),
        ...languageFor(lang),
        syntaxHighlighting(codeHighlightStyle),
        codeTheme,
        EditorView.lineWrapping,
        highlightSelectionMatches(),
        keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) onChangeRef.current(u.state.doc.toString());
        }),
      ],
    });
    const view = new EditorView({ state, parent: hostRef.current });
    viewRef.current = view;
    return () => { view.destroy(); viewRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- doc seeds on mount; value sync below
  }, [lang]);

  useEffect(() => {
    const v = viewRef.current;
    if (v && v.state.doc.toString() !== value) {
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
    }
  }, [value]);

  return <div ref={hostRef} className={className} />;
}

export function CodeView({ text, lang, className }: { text: string; lang?: string; className?: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);

  useEffect(() => {
    if (!hostRef.current) return;
    const state = EditorState.create({
      doc: text,
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        ...languageFor(lang),
        syntaxHighlighting(codeHighlightStyle),
        codeTheme,
        EditorView.lineWrapping,
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
      ],
    });
    const view = new EditorView({ state, parent: hostRef.current });
    viewRef.current = view;
    return () => view.destroy();
  }, [text, lang]);

  return <div ref={hostRef} className={className} />;
}
