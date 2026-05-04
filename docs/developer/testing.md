# Testing

## Running Tests

```bash
npm test
npm run test:coverage
npm run test:watch
```

## Test Structure

- Unit tests in `tests/`
- Named `*.test.ts`
- Uses Vitest

## Writing Tests

```typescript
import { describe, it, expect } from "vitest";

describe("feature", () => {
  it("should work", () => {
    expect(true).toBe(true);
  });
});
```
