### Changed
- **Repository pages, file views and commit history no longer clone the repository.** They
  now read through the Artifacts read API (`log`, `readTree`, `readFile`) instead of
  downloading and unpacking the repository inside the Worker. Directory listings are
  stored under their Git tree hash, so after a push only the directories on the changed
  paths are read again; on a repository the size of Stratum's that is a few calls instead
  of 44. If the read API fails, or a tree has more than 500 uncached directories, the page
  falls back to cloning as before. Each native read also checks that the repository it
  opened is the one the project's remote names.
