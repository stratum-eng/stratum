### Changed
- **The signed-in name in the top bar is now an account menu.** Profile, settings and logout
  sit under your name instead of as separate links in the bar; "new project" stays in the bar.
  The menu needs no JavaScript, works from the keyboard, and on phones opens in place inside
  the existing menu.
- **Form errors now show inline, under the field they are about.** The new-project and import
  form, the settings forms (display name, username, API tokens, agents), the webhook form and
  the deploy-secret form no longer pop the browser's validation bubbles. A refused submission
  comes back with the reason under the field, what you typed still filled in (including an API
  token's scope and project or organization limit, and every checked webhook event — but never
  a deploy secret's value, which is not carried back), and the field marked invalid for screen
  readers. Submitting the new-project form with a malformed or
  already-used name, or an import with an unsupported URL, now lands back on the form instead
  of on a raw JSON error; API callers still get JSON.
