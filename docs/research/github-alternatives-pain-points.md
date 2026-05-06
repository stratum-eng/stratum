# GitHub & Alternatives: Pain Points Analysis

## Executive Summary

Based on analysis of industry discussions and the video "What's next?" by Theo, this document catalogs the critical pain points with GitHub and its alternatives. The analysis reveals three distinct generations of source control platforms and identifies opportunities for Stratum to address unmet needs.

---

## Generation Framework

### Gen 1: Pre-Git (SVN, etc.)
- Centralized version control
- Enterprise-focused
- Examples: SVN, Perforce, CVS

### Gen 2: Git Era (Current)
- Distributed version control
- Web-based interfaces
- Social coding features
- **Leaders**: GitHub, GitLab, Bitbucket, Forgejo/Codeberg

### Gen 3: Agent-Native (Emerging)
- Built for AI/agent workflows
- Programmatic access
- Real-time collaboration
- **Players**: Pierre (code.storage), Entire, Graphite + Cursor

---

## GitHub Pain Points

### 1. **PR Review UX Issues** (Mitchell Hashimoto Thread)

**Key Quote:**
> "This is what GitHub PR review should feel like. And probably what it should look like too, the amount of whitespace and padding and fluff for fluffs sake gets in the way of what needs to be a power tool."

**Specific Issues:**
- Excessive whitespace and padding
- Too much "fluff for fluff's sake"
- Not designed as a "power tool"
- Performance issues with large diffs
- Counter-point: "You can just render big diffs. Browsers are fast."

**Stratum Implication:**
- Minimize UI chrome
- Maximize content area
- Fast diff rendering
- Keyboard shortcuts for power users

### 2. **Reliability & Downtime**
- **Issue**: Downtime measured in days instead of minutes
- **Impact**: Production workflows halted, CI/CD pipelines broken
- **Quote**: "GitHub might not be the safest place for us to be leaving our code now that they're randomly reverting merges and having downtime that is measured in days instead of minutes"
- **Root Cause**: Ruby-based architecture that doesn't scale horizontally well
- **Specific Problems**:
  - Random merge reverts
  - Extended outages
  - Degraded performance during high load

### 3. **Agent/AI Workflow Friction**
- **Issue**: Not designed for high-throughput agent workflows
- **Impact**: Agents generating hundreds/thousands of lines per session overwhelm the system
- **Statistics**: GitHub struggling with 20 million new repos while alternatives handle similar load fine
- **Quote**: "GitHub's complaining about... the massive increase in the number of pull requests, commits, and new repos that GitHub is seeing because agents are making more people do more projects and they can't handle the throughput"

### 4. **Poor CLI Experience**
- **Issue**: GitHub CLI is cumbersome and error-prone
- **Problems**:
  - 9+ steps to create and push a repo
  - Multiple loading blockers
  - 6-year-old bugs unfixed (option+delete crashes CLI)
  - Counter-intuitive navigation
- **Quote**: "The CLI is terrible. It's so bad... It doesn't handle escape sequences. They just never fixed it."

### 4. **Architecture Limitations**
- **Issue**: Built on Ruby stack that doesn't scale
- **Impact**: Performance degradation at scale
- **Quote**: "They're built on top of a pile of Ruby slop that horizontally scales almost decently but barely and they are hitting the limitations of the system that was built for multiple orders of magnitude less traffic than they're getting"

### 5. **Generational Obsolescence**
- **Issue**: Designed for human-centric workflows, not agentic development
- **Gap**: No native support for:
  - Programmatic repo creation
  - Ephemeral branches
  - In-memory writes
  - High-frequency commits
  - Context preservation for agents

---

## Alternative Analysis

### GitLab

#### X Thread Analysis (Jason Cox - @jasonbcox0)

**Opening Statement:**
> "There's a lot of confused people in this thread on why GitLab isn't an acceptable drop-in replacement for Github. I will periodically add some examples. These are UX monstrosities that make it *unusable*"

**Key Quote from Josh (@joshmanders):**
> "GitLab was designed by developers with no eye for design but think they do. The UX is atrocious as if they never used their own product. I'd let GitHub lose another 5-10% uptime before I'd consider switching to BitBucket before I'd consider GitLab."

#### Specific UX Issues (from thread):

**1. Project Page Layout Disaster**
- Landing on GitLab project page reaction: "WTF am I looking at? Where's the readme that tells me what I'm looking at?"
- **Problem**: README is 75% down the page
- **User expectation**: README should be immediately visible
- Quote: "If you are honest with yourself, your reaction should be: WTF am I looking at? Where's the readme that tells me what I'm looking at? The answer is scrolling 75% down the page."

**2. Visual Hierarchy Failures**
- All metadata numbers have same visual weight
- Tags, environments, and releases all look equally important
- Quote: "Somehow these numbers all have the same weight. Does this make sense to you? Or did you come here looking for releases like everyone else?"
- GitHub's UX has "trained you to look here" for releases

**3. Commit History Navigation Nightmare**
- Infinite scroll instead of pagination
- No date filtering
- No way to find commits from last year without command line
- Options presented: search by message (don't recall), author (can't remember), browse files (no date filter)
- Quote: "You got infinite scroll (nope), search by msg (don't recall the commit msg), author (can't recall who), browse files... How do I filter by date?"

**4. Release Page Confusion**
Multiple questions raised:
1. When was this released? (no date visible)
2. What is 88% complete? (mystery metric)
3. Was this actually released???

- Release date hidden in "gray-on-gray text"
- Must scroll through entire changelog to find date
- Quote: "Ok, I scrolled and found the release date. Hidden in the gray-on-gray text. It's there. I don't know what version I was looking at, but it's there."

**5. Commit Hash Disconnect**
- Clicking commit hash from release lands on unrelated commit
- Quote: "I click that commit hash, expecting to see what changed in this release, and... I land on this commit. What does this have to do with the release I was just looking at?"
- No way to see commit range for release
- Quote: "As I mentioned before, you cannot sift through commit ranges so having this hash is useless for me (unless I hit the command line, of course)."

**6. Missing "Next Commit" Navigation**
- Can go to parent commit but not child commit
- No way to see what changed immediately after a release
- Quote: "Now I want to see what was changed immediately after because something is breaking right after the release tag... And I can't. There is no 'next commit' button. Why? There is a parent commit. Just can't go the other direction."

#### Additional Pain Points (from video):

**1. Atrocious UX**
- Quote: "GitLab was designed by developers with no eye for design, but think they do. The UX is atrocious as if they never use their own product."
- "I'd let GitHub lose another 5 to 10% uptime before I consider switching to Bitbucket before I would consider switching to GitLab"

**2. Loading Behavior Issues**
- Double/triple loading layers
- Content disappears on navigation
- Back button breaks content loading
- Example: Click repo → go back → repos don't load

**3. Technical Debt**
- 1.6 million lines of code
- 528,000 commits (half a million)
- Still on Vue 2 (not Vue 3)
- Clone takes 5+ minutes just to start
- Quote: "You're not vibe coding your way out of the issues here"

**4. Gen 2 Limitation**
- Not a generational improvement over GitHub
- Quote: "GitLab is just a worse version of GitHub the same way Azure is just a worse version of AWS"

#### Verdict: 
Worse GitHub clone with better uptime but terrible UX. Enterprise-focused, not developer-friendly.

---

### Bitbucket

#### Pain Points:

1. **Jira-Centric Design**
   - Tagline: "Git solutions for teams using Jira"
   - Value proposition is integration, not git
   - Quote: "The value you get out of Bitbucket is if you're already a big customer of Atlassian, it integrates with your other Atlassian stuff. That's it."

2. **Pricing-First Marketing**
   - Leads with "10x savings" not features
   - Compares against GitHub's most expensive tier intentionally
   - Quote: "When number goes up, number goes up. This chart should tell you everything you need to see about why this is not the solution for you."

3. **No Differentiation**
   - No compelling features over GitHub
   - Just cheaper (and worse)

#### Verdict:
Only valuable if deeply invested in Atlassian ecosystem.

---

### Gitea → Forgejo

#### Gitea Issues:

1. **Rug Pull / License Change**
   - Went from open source to commercial model
   - Community felt betrayed
   - Quote: "The people running it decided they wanted to go more private and charge for it. The community felt rugpulled and they forked."

2. **False Advertising**
   - Uses questionable testimonials
   - Fake/anonymous accounts as quotes
   - Still marketed as "private, fast, reliable" not "open"

#### Forgejo (The Fork) - POSITIVE EXAMPLE:

**Strengths:**

1. **Good Governance**
   - Non-profit democratic organization (Codeberg EV)
   - Truly free software
   - Community-driven

2. **Solid Technical Foundation**
   - 400k lines of Go (not Ruby)
   - Much smaller codebase than GitLab
   - Fast and lightweight
   - Latest Node.js version

3. **Developer-Friendly UI**
   - Releases as top-level tab
   - Shows commits in releases
   - RSS feed support
   - Customizable themes
   - Code review that "just works"

4. **Actions Support**
   - Can use GitHub Actions YAML files
   - Self-hostable runners
   - Bring your own machine support

5. **Transparency**
   - Public status updates on Mastodon
   - Detailed incident reports
   - Quote: "I would kill for this level of transparency from GitHub"

**Weaknesses:**

1. **Resource Constraints**
   - Underfunded ($300/week in donations)
   - Small team
   - Limited feature velocity

2. **Basic UI/UX**
   - Quote: "It's ugly as sin, but it's doing exactly what I need it to do"
   - Readme still requires scrolling
   - Loading states can be slow
   - Some jank in transitions

3. **No Generational Leap**
   - Still Gen 2 (GitHub clone)
   - Not built for agent workflows

#### Verdict:
Best current open-source alternative for self-hosting. Solid, functional, but basic.

---

### Pierre (code.storage)

**Position**: Building Gen 3 primitives

**Strengths:**

1. **Agent-Native Architecture**
   - Built for high-throughput agent workflows
   - Handles 15,000 repos per minute sustained
   - 9 million repos in 30 days
   - No downtime under massive load

2. **Programmatic-First Design**
   - One-line repo creation: `store.createRepo()`
   - vs GitHub's 9-step CLI process
   - SDK-first, not web-first

3. **Modern Primitives**
   - Ephemeral branches
   - In-memory writes
   - Cold storage options
   - Built for AI-generated code volume

4. **Supporting Tools**
   - diffs.com - best-in-class diff rendering
   - trees.software - file tree rendering
   - Open source components

**Status:**
- Infrastructure not yet publicly available (waitlist)
- Building blocks for others to use
- Quote: "They're building all the missing primitives we need"

#### Verdict:
Not a GitHub replacement, but the foundation for Gen 3 tools.

---

### Entire

**Position**: Rethinking version control for agents

**Key Insight:**
- Git preserves WHAT changed, not WHY
- Agents need context about reasoning
- Quote: "With agents generating hundreds or thousands of lines per session, this context loss compounds fast"

**Approach:**
- More durable history alongside code
- Context preservation for agent collaboration
- Prevents "retracing steps, duplicating reasoning"

**Status:**
- Early stage (just announced $60M seed)
- Former GitHub CEO leading
- First product: CLI for tracking agent context

**Questions:**
- May abandon Git entirely (risky)
- CRDT-based approach (like Zed's Delta DB)

---

### Graphite + Cursor

**Position**: Better workflows on top of GitHub

**Evolution:**
1. Started as GitHub enhancement layer (stacked PRs, better code review)
2. Hit GitHub API limitations
3. Started mirroring repos to own infrastructure
4. Acquired by Cursor

**Future:**
- Likely to build deeper integration with Cursor
- May become full GitHub alternative
- Focus on AI-native development workflows

**Risk:**
- Still somewhat dependent on GitHub
- Unclear long-term direction post-acquisition

---

## Community & Ecosystem Pain Points

### The Great Fracturing

**Problem**: 
As projects leave GitHub, the unified developer profile and project discovery breaks down.

**Quote:**
"The great fracturing has begun. Some projects will go to some weird federated [stuff]... Some people will go to Forgejo. Some will go to GitLab. Some will go to self-hosted instances. They're all going to go different places."

**Lost Capabilities:**
- Single profile showing all contributions
- Cross-project discoverability
- Unified issue tracking and discussion
- Network effects of centralized platform

**Quote:**
"This consistent history where you could click one person's username and see everything they've done for the last 20 years. That's over now."

---

## How Stratum Can Win

### 1. **Reliability-First Architecture**

**Learn from GitHub's failures:**
- Don't build on Ruby/Rails monolith
- Design for horizontal scaling from day 1
- Multi-region redundancy
- Graceful degradation

**Specific Actions:**
- Use Cloudflare Workers (edge-deployed, globally distributed)
- Stateless design where possible
- Durable Objects for coordination
- Queue-based async processing for imports/operations

### 2. **Agent-Native by Default**

**Don't retrofit, design for it:**
- Programmatic API as first-class citizen
- Support high-throughput operations
- Context preservation built-in
- Agent identity and attribution

**Specific Features:**
```typescript
// One-line repo creation (like Pierre)
const repo = await stratum.createRepo({ name, namespace });

// Agent context tracking
await stratum.commit({
  changes,
  agent: agentId,
  context: reasoningContext,
  parentCommits
});
```

### 3. **UX That Doesn't Suck**

**Learn from GitLab's mistakes:**
- Clean, minimal interface
- Important info above the fold
- No infinite scroll for critical paths
- Consistent navigation

**Specific Principles:**
- README first (not buried)
- Releases prominently displayed
- Clear visual hierarchy
- Fast load times (<100ms for core pages)

### 4. **Generational Leap (Gen 2.5/3)**

**Position between Forgejo and Pierre:**
- More usable than Forgejo (better UX)
- More accessible than Pierre (fully available)
- Git-compatible but enhanced
- Workspace-based collaboration (not just PRs)

### 5. **Workspace-Centric Model**

**Different from GitHub's repo-centric:**
- Projects have workspaces
- Workspaces can be ephemeral
- Easy fork/merge workflows
- AI-friendly branching strategies

**Quote from Stratum docs:**
"Stratum is a platform for agentic software development, providing workspaces where AI agents and humans collaborate on code changes."

### 6. **Transparent Operations**

**Learn from Codeberg:**
- Public status page
- Detailed incident reports
- Open about limitations
- Community-driven roadmap

### 7. **Avoid GitLab's Complexity**

**Keep it simple:**
- Focus on core workflows
- Don't try to be everything
- Avoid 1.6M lines of code
- Stay lean and maintainable

### 8. **Bridge the Community Gap**

**Address the fracturing:**
- Federation with other Git hosts?
- Import/mirror capabilities
- Cross-platform identity
- Don't require abandoning GitHub entirely

---

## Competitive Positioning

### vs GitHub
- **More reliable** (edge infrastructure)
- **Agent-native** (built for AI workflows)
- **Workspace-based** (not just repos)
- **Transparent** (open operations)

### vs GitLab
- **Better UX** (designed for humans)
- **Faster** (modern stack)
- **Simpler** (focused scope)

### vs Forgejo
- **Better funded** (sustainable development)
- **More modern** (Cloudflare stack)
- **Agent-ready** (not just Git host)

### vs Pierre/Entire
- **Available now** (not waitlist)
- **Git-compatible** (familiar workflows)
- **Complete platform** (not just primitives)

---

## Technical Recommendations

### 1. **Architecture Decisions**

✅ **DO:**
- Cloudflare Workers (edge computing)
- D1 (SQLite at edge)
- Artifacts (Git hosting)
- Queue-based processing
- Stateless design

❌ **DON'T:**
- Ruby/Rails monolith
- Centralized single-region hosting
- Synchronous heavy operations
- Complex JavaScript frontend frameworks

### 2. **UX Priorities**

✅ **DO:**
- README first
- Fast page loads
- Clear navigation
- Progressive enhancement
- Mobile-friendly

❌ **DON'T:**
- Infinite scroll for history
- Deep nesting
- Hidden information
- Slow loading states

### 3. **Agent Support**

✅ **DO:**
- API-first design
- Webhook support
- Context preservation
- High-rate limits
- Programmatic access

---

## Conclusion

The market is experiencing a "great fracturing" as GitHub struggles with reliability and the industry moves toward agentic development. Current alternatives fall into two camps:

1. **Gen 2 clones** (GitLab, Bitbucket, Forgejo) - functional but not generational improvements
2. **Gen 3 primitives** (Pierre, Entire) - promising but not yet complete platforms

**Stratum's Opportunity:**
Be the Gen 2.5/3 platform that bridges the gap:
- Available and usable today (unlike Pierre/Entire)
- Agent-native (unlike GitHub/GitLab)
- Reliable and scalable (unlike GitHub's Ruby stack)
- Simple and focused (unlike GitLab's complexity)
- Workspace-based collaboration (new paradigm)

The window is open. GitHub is faltering. Alternatives are flawed. The community is looking for a new home.

---

## References

### Primary Sources

**Video:**
- "What's next?" by Theo (@t3dotgg) - Comprehensive analysis of GitHub alternatives
  - YouTube: https://www.youtube.com/watch?v=HuE7OvOckfE

**X/Twitter Threads:**

1. **Jason Cox on GitLab UX Issues** (@jasonbcox0)
   - URL: https://x.com/jasonbcox0/status/2049244913842426230
   - Date: April 28, 2025
   - Key Topics: GitLab UX failures, unusable interface, specific examples from GitLab project
   - Mirror: https://twitter-thread.com/t/2049244913842426230

2. **Mitchell Hashimoto on GitHub PR Review** (@mitchellh)
   - URL: https://x.com/mitchellh/status/1983896884222861474
   - Date: October 30, 2025
   - Key Topics: GitHub PR review UX issues, whitespace/padding problems, need for power tools
   - Mirror: https://twitter-thread.com/t/1983896884222861474

### Secondary Sources

- GitLab project analysis (1.6M LOC, Vue 2)
- Forgejo/Codeberg evaluation
- Pierre (code.storage) documentation
- Entire announcement and CLI documentation
- Graphite.dev acquisition by Cursor context

### Related Reading

- Gen 1→2→3 framework for developer tools
- Agent-native development trends
- Code review UX best practices
- Git hosting scalability challenges
