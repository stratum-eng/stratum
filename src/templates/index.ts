/**
 * Import templates for common project types
 * Provides pre-configured project templates for quick setup
 */

import type { ImportTemplate } from "../types";

/**
 * React project template with TypeScript and Vite
 */
export const reactTemplate: ImportTemplate = {
  id: "react-ts",
  name: "React + TypeScript",
  description: "Modern React application with TypeScript and Vite",
  language: "typescript",
  framework: "react",
  files: {
    "package.json": JSON.stringify(
      {
        name: "{{projectName}}",
        private: true,
        version: "0.0.0",
        type: "module",
        scripts: {
          dev: "vite",
          build: "tsc && vite build",
          preview: "vite preview",
          lint: "eslint . --ext ts,tsx --report-unused-disable-directives --max-warnings 0",
        },
        dependencies: {
          react: "^18.2.0",
          "react-dom": "^18.2.0",
        },
        devDependencies: {
          "@types/react": "^18.2.43",
          "@types/react-dom": "^18.2.17",
          "@typescript-eslint/eslint-plugin": "^6.14.0",
          "@typescript-eslint/parser": "^6.14.0",
          "@vitejs/plugin-react": "^4.2.1",
          eslint: "^8.55.0",
          "eslint-plugin-react-hooks": "^4.6.0",
          "eslint-plugin-react-refresh": "^0.4.5",
          typescript: "^5.2.2",
          vite: "^5.0.8",
        },
      },
      null,
      2,
    ),
    "tsconfig.json": JSON.stringify(
      {
        compilerOptions: {
          target: "ES2020",
          useDefineForClassFields: true,
          lib: ["ES2020", "DOM", "DOM.Iterable"],
          module: "ESNext",
          skipLibCheck: true,
          moduleResolution: "bundler",
          allowImportingTsExtensions: true,
          resolveJsonModule: true,
          isolatedModules: true,
          noEmit: true,
          jsx: "react-jsx",
          strict: true,
          noUnusedLocals: true,
          noUnusedParameters: true,
          noFallthroughCasesInSwitch: true,
        },
        include: ["src"],
        references: [{ path: "./tsconfig.node.json" }],
      },
      null,
      2,
    ),
    "tsconfig.node.json": JSON.stringify(
      {
        compilerOptions: {
          composite: true,
          skipLibCheck: true,
          module: "ESNext",
          moduleResolution: "bundler",
          allowSyntheticDefaultImports: true,
        },
        include: ["vite.config.ts"],
      },
      null,
      2,
    ),
    "vite.config.ts": `import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
})
`,
    "index.html": `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <link rel="icon" type="image/svg+xml" href="/vite.svg" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>{{projectName}}</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`,
    "src/main.tsx": `import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
`,
    "src/App.tsx": `import { useState } from 'react'
import './App.css'

function App() {
  const [count, setCount] = useState(0)

  return (
    <>
      <h1>{{projectName}}</h1>
      <div className="card">
        <button onClick={() => setCount((count) => count + 1)}>
          count is {count}
        </button>
      </div>
      <p className="read-the-docs">
        Edit src/App.tsx to get started
      </p>
    </>
  )
}

export default App
`,
    "src/index.css": `:root {
  font-family: Inter, system-ui, Avenir, Helvetica, Arial, sans-serif;
  line-height: 1.5;
  font-weight: 400;
  color-scheme: light dark;
  color: rgba(255, 255, 255, 0.87);
  background-color: #242424;
  font-synthesis: none;
  text-rendering: optimizeLegibility;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

body {
  margin: 0;
  display: flex;
  place-items: center;
  min-width: 320px;
  min-height: 100vh;
}

h1 {
  font-size: 3.2em;
  line-height: 1.1;
}

button {
  border-radius: 8px;
  border: 1px solid transparent;
  padding: 0.6em 1.2em;
  font-size: 1em;
  font-weight: 500;
  font-family: inherit;
  background-color: #1a1a1a;
  cursor: pointer;
  transition: border-color 0.25s;
}

button:hover {
  border-color: #646cff;
}

.card {
  padding: 2em;
}

.read-the-docs {
  color: #888;
}
`,
    "src/App.css": `#root {
  max-width: 1280px;
  margin: 0 auto;
  padding: 2rem;
  text-align: center;
}

.logo {
  height: 6em;
  padding: 1.5em;
  will-change: filter;
  transition: filter 300ms;
}

.logo:hover {
  filter: drop-shadow(0 0 2em #646cffaa);
}
`,
    "README.md": `# {{projectName}}

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

## Getting Started

\`\`\`bash
# Install dependencies
npm install

# Start development server
npm run dev
\`\`\`

## Building

\`\`\`bash
npm run build
\`\`\`
`,
    ".eslintrc.cjs": `module.exports = {
  root: true,
  env: { browser: true, es2020: true },
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:react-hooks/recommended',
  ],
  ignorePatterns: ['dist', '.eslintrc.cjs'],
  parser: '@typescript-eslint/parser',
  plugins: ['react-refresh'],
  rules: {
    'react-refresh/only-export-components': [
      'warn',
      { allowConstantExport: true },
    ],
  },
}
`,
    ".gitignore": `# Logs
logs
*.log
npm-debug.log*
yarn-debug.log*
yarn-error.log*
pnpm-debug.log*
lerna-debug.log*

node_modules
dist
dist-ssr
*.local

# Editor directories and files
.vscode/*
!.vscode/extensions.json
.idea
.DS_Store
*.suo
*.ntvs*
*.njsproj
*.sln
*.sw?
`,
  },
  postSetupHooks: ["npm install"],
};

/**
 * Node.js project template with TypeScript
 */
export const nodeTemplate: ImportTemplate = {
  id: "node-ts",
  name: "Node.js + TypeScript",
  description: "Node.js application with TypeScript and modern tooling",
  language: "typescript",
  framework: "nodejs",
  files: {
    "package.json": JSON.stringify(
      {
        name: "{{projectName}}",
        version: "1.0.0",
        description: "Node.js TypeScript project",
        main: "dist/index.js",
        type: "module",
        scripts: {
          build: "tsc",
          start: "node dist/index.js",
          dev: "tsx watch src/index.ts",
          lint: "eslint src/**/*.ts",
          test: "vitest",
        },
        keywords: [],
        author: "",
        license: "MIT",
        devDependencies: {
          "@types/node": "^20.10.0",
          "@typescript-eslint/eslint-plugin": "^6.14.0",
          "@typescript-eslint/parser": "^6.14.0",
          eslint: "^8.55.0",
          tsx: "^4.7.0",
          typescript: "^5.3.0",
          vitest: "^1.1.0",
        },
      },
      null,
      2,
    ),
    "tsconfig.json": JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "Node16",
          lib: ["ES2022"],
          moduleResolution: "Node16",
          rootDir: "./src",
          outDir: "./dist",
          removeComments: true,
          esModuleInterop: true,
          forceConsistentCasingInFileNames: true,
          strict: true,
          skipLibCheck: true,
          resolveJsonModule: true,
          declaration: true,
          declarationMap: true,
          sourceMap: true,
        },
        include: ["src/**/*"],
        exclude: ["node_modules", "dist"],
      },
      null,
      2,
    ),
    "src/index.ts": `import { createServer } from './server.js';

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

const server = createServer();

server.listen(PORT, () => {
  console.log(\`Server running on http://localhost:\${PORT}\`);
});
`,
    "src/server.ts": `import { createServer as createHttpServer, IncomingMessage, ServerResponse } from 'http';

export function createServer() {
  return createHttpServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url || '/';
    
    if (url === '/') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ 
        message: 'Welcome to {{projectName}}!',
        status: 'ok',
        timestamp: new Date().toISOString()
      }));
    } else if (url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'healthy' }));
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    }
  });
}
`,
    "src/server.test.ts": `import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from './server.js';
import type { Server } from 'http';

describe('Server', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = createServer();
    await new Promise<void>((resolve) => {
      server.listen(0, () => {
        const address = server.address();
        if (address && typeof address === 'object') {
          baseUrl = \`http://localhost:\${address.port}\`;
        }
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('should return welcome message on root path', async () => {
    const response = await fetch(baseUrl + '/');
    const data = await response.json();
    
    expect(response.status).toBe(200);
    expect(data.message).toBe('Welcome to {{projectName}}!');
    expect(data.status).toBe('ok');
  });

  it('should return health status', async () => {
    const response = await fetch(baseUrl + '/health');
    const data = await response.json();
    
    expect(response.status).toBe(200);
    expect(data.status).toBe('healthy');
  });

  it('should return 404 for unknown paths', async () => {
    const response = await fetch(baseUrl + '/unknown');
    expect(response.status).toBe(404);
  });
});
`,
    "README.md": `# {{projectName}}

Node.js TypeScript project with modern tooling.

## Features

- TypeScript for type safety
- ES modules (type: "module")
- Vitest for testing
- ESLint for code quality
- Hot reload in development

## Getting Started

\`\`\`bash
# Install dependencies
npm install

# Start development server with hot reload
npm run dev

# Build for production
npm run build

# Start production server
npm start

# Run tests
npm test
\`\`\`

## Project Structure

\`\`\`
src/
  index.ts       # Application entry point
  server.ts      # HTTP server implementation
  server.test.ts # Server tests
\`\`\`
`,
    ".eslintrc.cjs": `module.exports = {
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
  ],
  env: {
    node: true,
    es2022: true,
  },
  rules: {
    '@typescript-eslint/explicit-function-return-type': 'off',
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
  },
};
`,
    ".gitignore": `# Dependencies
node_modules/

# Build output
dist/
build/

# Logs
logs
*.log
npm-debug.log*
yarn-debug.log*
yarn-error.log*
pnpm-debug.log*
lerna-debug.log*

# Environment variables
.env
.env.local
.env.*.local

# Editor directories and files
.vscode/*
!.vscode/extensions.json
.idea
.DS_Store
*.suo
*.ntvs*
*.njsproj
*.sln
*.sw?

# Testing
coverage/

# Temporary files
*.tmp
*.temp
`,
  },
  postSetupHooks: ["npm install"],
};

/**
 * Python project template
 */
export const pythonTemplate: ImportTemplate = {
  id: "python",
  name: "Python",
  description: "Python project with modern tooling and best practices",
  language: "python",
  files: {
    "pyproject.toml": `[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[project]
name = "{{projectName}}"
version = "0.1.0"
description = "Python project"
readme = "README.md"
requires-python = ">=3.10"
license = "MIT"
keywords = []
authors = [
  { name = "", email = "" },
]
classifiers = [
  "Development Status :: 4 - Beta",
  "Programming Language :: Python",
  "Programming Language :: Python :: 3.10",
  "Programming Language :: Python :: 3.11",
  "Programming Language :: Python :: 3.12",
]
dependencies = [
  "fastapi>=0.100.0",
  "uvicorn[standard]>=0.23.0",
]

[project.optional-dependencies]
dev = [
  "pytest>=7.4.0",
  "pytest-cov>=4.1.0",
  "ruff>=0.1.0",
  "mypy>=1.6.0",
  "black>=23.0.0",
]

[project.scripts]
{{projectName}} = "{{projectName}}.cli:main"

[tool.hatch.version]
path = "src/{{projectName}}/__init__.py"

[tool.hatch.build.targets.wheel]
packages = ["src/{{projectName}}"]

[tool.ruff]
target-version = "py310"
line-length = 100
select = [
  "A",
  "ARG",
  "B",
  "C",
  "DTZ",
  "E",
  "EM",
  "F",
  "FBT",
  "I",
  "N",
  "PLC",
  "PLE",
  "PLR",
  "PLW",
  "Q",
  "RUF",
  "S",
  "T",
  "TID",
  "UP",
  "W",
  "YTT",
]
ignore = [
  # Allow non-abstract empty methods in abstract base classes
  "B027",
  # Allow boolean positional values in function calls
  "FBT003",
  # Ignore checks for possible passwords
  "S105", "S106", "S107",
]

[tool.ruff.pydocstyle]
convention = "google"

[tool.black]
target-version = ["py310"]
line-length = 100
skip-string-normalization = true

[tool.mypy]
python_version = "3.10"
warn_return_any = true
warn_unused_configs = true
disallow_untyped_defs = true

[tool.pytest.ini_options]
testpaths = ["tests"]
pythonpath = ["src"]
`,
    "src/{{projectName}}/__init__.py": `"""{{projectName}} package."""

__version__ = "0.1.0"
`,
    "src/{{projectName}}/main.py": `"""Main application module."""

from fastapi import FastAPI
from fastapi.responses import JSONResponse

app = FastAPI(title="{{projectName}}")


@app.get("/")
async def root() -> dict[str, str]:
    """Root endpoint."""
    return {
        "message": "Welcome to {{projectName}}!",
        "status": "ok",
    }


@app.get("/health")
async def health() -> dict[str, str]:
    """Health check endpoint."""
    return {"status": "healthy"}
`,
    "src/{{projectName}}/cli.py": `"""Command line interface."""

import sys

import uvicorn

from {{projectName}}.main import app


def main() -> int:
    """Run the application."""
    uvicorn.run(app, host="0.0.0.0", port=8000)
    return 0


if __name__ == "__main__":
    sys.exit(main())
`,
    "tests/__init__.py": "",
    "tests/test_main.py": `"""Tests for main module."""

from fastapi.testclient import TestClient

from {{projectName}}.main import app


client = TestClient(app)


def test_root():
    """Test root endpoint."""
    response = client.get("/")
    assert response.status_code == 200
    assert response.json()["message"] == "Welcome to {{projectName}}!"
    assert response.json()["status"] == "ok"


def test_health():
    """Test health endpoint."""
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["status"] == "healthy"
`,
    "README.md": `# {{projectName}}

Python project with modern tooling and best practices.

## Features

- FastAPI for modern web development
- Ruff for fast Python linting
- Black for code formatting
- MyPy for static type checking
- Pytest for testing
- Hatchling for packaging

## Getting Started

\`\`\`bash
# Create virtual environment
python -m venv venv

# Activate virtual environment
# On macOS/Linux:
source venv/bin/activate
# On Windows:
# venv\\Scripts\\activate

# Install dependencies
pip install -e ".[dev]"

# Run the application
python -m {{projectName}}

# Run tests
pytest

# Run linting
ruff check .

# Run type checking
mypy src

# Format code
black src tests
\`\`\`

## Project Structure

\`\`\`
src/
  {{projectName}}/
    __init__.py    # Package initialization
    main.py        # FastAPI application
    cli.py         # Command line interface
tests/
  __init__.py
  test_main.py     # Main module tests
pyproject.toml     # Project configuration
\`\`\`
`,
    ".gitignore": `# Byte-compiled / optimized / DLL files
__pycache__/
*.py[cod]
*$py.class

# C extensions
*.so

# Distribution / packaging
.Python
build/
develop-eggs/
dist/
downloads/
eggs/
.eggs/
lib/
lib64/
parts/
sdist/
var/
wheels/
share/python-wheels/
*.egg-info/
.installed.cfg
*.egg
MANIFEST

# Virtual environments
venv/
ENV/
env/
.env
.venv

# IDE
.vscode/
.idea/
*.swp
*.swo
*~

# Testing
.coverage
.pytest_cache/
htmlcov/
.tox/

# MyPy
.mypy_cache/
.dmypy.json
dmypy.json

# Ruff
.ruff_cache/
`,
  },
  postSetupHooks: ["python -m venv venv", "pip install -e .[dev]"],
};

/**
 * All available templates
 */
export const templates: ImportTemplate[] = [reactTemplate, nodeTemplate, pythonTemplate];

/**
 * Get a template by ID
 */
export function getTemplate(id: string): ImportTemplate | undefined {
  return templates.find((t) => t.id === id);
}

/**
 * Process a template with project-specific values
 */
export function processTemplate(
  template: ImportTemplate,
  projectName: string,
): Record<string, string> {
  const processed: Record<string, string> = {};
  const normalizedName = projectName.toLowerCase().replace(/[^a-z0-9]/g, "_");

  for (const [path, content] of Object.entries(template.files)) {
    // Replace {{projectName}} placeholder
    const processedPath = path.replace(/\{\{projectName\}\}/g, normalizedName);
    const processedContent = content.replace(/\{\{projectName\}\}/g, projectName);

    processed[processedPath] = processedContent;
  }

  return processed;
}

/**
 * List all available templates
 */
export function listTemplates(): Array<{
  id: string;
  name: string;
  description: string;
  language: string;
  framework?: string;
}> {
  return templates.map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    language: t.language,
    framework: t.framework,
  }));
}

export { templates as default };
