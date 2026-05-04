# Local Development Setup

## Prerequisites

- Node.js 20+
- npm
- Cloudflare account

## Setup

```bash
git clone https://github.com/jlamoreaux/stratum.git
cd stratum
npm install
npx wrangler login
npx wrangler d1 create stratum --local
npx wrangler d1 migrations apply stratum --local
npm run dev
```

Visit http://localhost:8787
