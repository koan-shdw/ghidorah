# Open-source fit

The closest references found during the repo-map investigation were:

- [Aider's repository map](https://aider.chat/docs/repomap.html): concise symbol context,
  graph-based relevance and bounded retrieval rather than dumping a tree into every prompt.
- [pi-repomap](https://github.com/EnTeQuAk/pi-repomap): Tree-sitter outlines, incremental caching,
  ranking and a model-facing query surface, integrated with the pi agent.
- [Atlas](https://github.com/Brair-Mpagi/Atlas): a Python-focused persistent code-intelligence
  layer with provenance and explicit uncertainty in graph relationships.

These are useful design references, not claims that their full products were integrated or that
performance comparisons were run. None of their code was copied into this implementation.

The current implementation uses the existing pinned open-source TypeScript compiler for JS/TS
syntax trees and Python's standard-library AST for Python. A single local engine feeds the CLI,
portable skill and Ghidorah panel; no native Tree-sitter ABI or graph database is required.
This deliberately trades broad language/call-graph coverage for a smaller initial runtime.
Unsupported languages and unresolved imports are exposed rather than guessed.

The visual layer is secondary to bounded file/symbol retrieval and honest freshness checks.
There is no measured claim of reduced model spending yet: that requires task-level comparisons
of tokens, time and correctness, not just a working graph.
