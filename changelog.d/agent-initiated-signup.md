### Added
- **Agents can sign their humans up.** `POST /api/agent-signup` takes an email, a username,
  and the agent's name, emails that address an approval link that names the agent, and gives
  the agent a short code to show its human. Following the link and typing the code creates the
  account (same invite gate and username rules as the signup form) and
  signs the person in; the agent, polling `POST /api/agent-signup/poll`, then receives its
  own agent token under the new account. The code is never emailed, so nobody can get an
  account approved for an address that isn't theirs. Nothing is created until approval, an
  address that already has an account is refused rather than attached to, and the send caps
  of the web form apply. Operators can turn it off with `AGENT_SIGNUP_DISABLED=1`.
