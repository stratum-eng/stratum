### Changed
- **The signed-in name in the top bar is now an account menu.** Profile, settings and logout
  sit under your name instead of as separate links in the bar; "new project" stays in the bar.
  The menu needs no JavaScript, works from the keyboard, and on phones opens in place inside
  the existing menu.
- **Form errors now show inline, under the field they are about.** The new-project and import
  form, the settings forms (display name, username, API tokens, agents), the webhook form and
  the deploy-secret form no longer pop the browser's validation bubbles. A refused submission
  comes back with the reason under the field and the field marked invalid for screen readers.
  The new-project, import, settings and webhook forms also come back with what you submitted
  still filled in, including an API token's scope and project or organization limit and every
  checked webhook event. The deploy-secret form shows the reason but does not refill. Values are
  only ever refilled from the submission itself, never from a link, so nobody can send you a
  form that is already filled in. Submitting the new-project form with a malformed or
  already-used name, or an import with an unsupported URL, now gets the form back instead of a
  raw JSON error; API callers still get JSON.
