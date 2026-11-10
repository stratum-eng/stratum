### Fixed
- **The `llm` evaluator failed every change on a policy that did not name a
  model.** Its default, `@cf/meta/llama-3.1-8b-instruct`, was retired by
  Workers AI on 2026-05-30, so the review failed closed with
  `LLM error: 5028`. Workers AI models that are current also answer in a
  different format from the retired ones, which Stratum read as an empty
  verdict; both formats are now read.

### Changed
- **The default model for the `llm` evaluator is now
  `@cf/meta/llama-4-scout-17b-16e-instruct`.** A policy that names its own
  `model` is unaffected. If you name a model that reasons before it answers,
  it may need a `timeoutMs` above the 30-second default on a large diff.
