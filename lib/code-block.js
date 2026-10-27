// lib/code-block.js — pure, DOM-free helpers for the "code block mode" feature.
// Loaded as a classic content-script file (before content_script.js) and by the Node tests.
// Attaches to globalThis so both the content-script isolated world and Node can reach it.
(function (root) {
  // Only languages we can name confidently are spoken; anything else is just "code block".
  // Keys are lower-case tokens as they appear in highlighter class names.
  const LANGUAGES = {
    bash: "Bash",
    sh: "Shell",
    shell: "Shell",
    zsh: "Shell",
    console: "Shell",
    c: "C",
    cpp: "C++",
    "c++": "C++",
    cs: "C#",
    csharp: "C#",
    css: "CSS",
    diff: "Diff",
    dockerfile: "Dockerfile",
    go: "Go",
    golang: "Go",
    graphql: "GraphQL",
    hcl: "HCL",
    terraform: "Terraform",
    html: "HTML",
    xml: "XML",
    java: "Java",
    javascript: "JavaScript",
    js: "JavaScript",
    jsx: "JSX",
    json: "JSON",
    kotlin: "Kotlin",
    kt: "Kotlin",
    lua: "Lua",
    makefile: "Makefile",
    markdown: "Markdown",
    md: "Markdown",
    php: "PHP",
    plaintext: "plain text",
    text: "plain text",
    txt: "plain text",
    python: "Python",
    py: "Python",
    r: "R",
    ruby: "Ruby",
    rb: "Ruby",
    rust: "Rust",
    rs: "Rust",
    scala: "Scala",
    sql: "SQL",
    swift: "Swift",
    toml: "TOML",
    ts: "TypeScript",
    typescript: "TypeScript",
    tsx: "TSX",
    yaml: "YAML",
    yml: "YAML",
  };

  // Tokens that commonly carry the language in class attributes:
  //   language-python  lang-ts  brush: bash;  hljs javascript  (bare token)
  function languageFromClass(className) {
    if (typeof className !== "string" || !className.trim()) return null;
    const lower = className.toLowerCase();
    const prefixed = /(?:^|[\s;:])(?:language|lang|brush)[-:\s]+([a-z0-9+#]+)/.exec(lower);
    if (prefixed && LANGUAGES[prefixed[1]]) return LANGUAGES[prefixed[1]];
    for (const token of lower.split(/[\s;:]+/)) {
      // Bare single letters ("c", "r") are too easy to collide with utility classes;
      // those languages are only recognised via the prefixed form (language-c).
      if (token.length >= 2 && LANGUAGES[token]) return LANGUAGES[token];
    }
    return null;
  }

  function countCodeLines(text) {
    if (!text) return 0;
    return text.split("\n").filter((line) => line.trim().length > 0).length;
  }

  /** Short spoken stand-in for a code block, e.g. "Python code block, 12 lines." */
  function describeCodeBlock(text, className) {
    const lines = countCodeLines(text);
    if (lines === 0) return "Empty code block.";
    const lang = languageFromClass(className);
    const head = lang ? `${lang} code block` : "Code block";
    return `${head}, ${lines} ${lines === 1 ? "line" : "lines"}.`;
  }

  root.OpenVoxCodeBlock = { describeCodeBlock, languageFromClass, countCodeLines };
})(typeof globalThis !== "undefined" ? globalThis : this);
