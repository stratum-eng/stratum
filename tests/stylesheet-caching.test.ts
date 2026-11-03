import { describe, expect, it, vi } from "vitest";
import app from "../src/index";
import type { Env } from "../src/types";
import { CSS } from "../src/ui/styles";
import { CSS_VERSION, STYLESHEET_HREF, STYLESHEET_LINKS_HTML } from "../src/ui/stylesheet";

function makeEnv(): Env {
  return {
    ARTIFACTS: { get: vi.fn(), create: vi.fn() } as unknown as Env["ARTIFACTS"],
    STATE: {
      get: vi.fn(async () => null),
      put: vi.fn(async () => undefined),
    } as unknown as KVNamespace,
    DB: {} as D1Database,
  } as unknown as Env;
}

describe("stylesheet delivery", () => {
  it("caches the versioned stylesheet URL for a year, immutably", async () => {
    const res = await app.fetch(new Request(`http://localhost${STYLESHEET_HREF}`), makeEnv());

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    expect(await res.text()).toBe(CSS);
  });

  it("gives an unversioned or stale URL only a short TTL, since its content may change", async () => {
    for (const path of ["/ui.css", "/ui.css?v=00000000"]) {
      const res = await app.fetch(new Request(`http://localhost${path}`), makeEnv());
      expect(res.headers.get("Cache-Control")).toBe("public, max-age=300");
    }
  });

  it("versions the URL by content", () => {
    expect(STYLESHEET_HREF).toBe(`/ui.css?v=${CSS_VERSION}`);
    expect(CSS_VERSION).toMatch(/^[0-9a-f]{8}$/);
  });

  it("does not @import the font from the stylesheet, which serialized the font behind the CSS", () => {
    expect(CSS).not.toContain("@import");
    expect(STYLESHEET_LINKS_HTML).toContain('rel="preconnect" href="https://fonts.gstatic.com"');
    expect(STYLESHEET_LINKS_HTML).toContain("fonts.googleapis.com/css2?family=JetBrains+Mono");
  });

  it("links the versioned stylesheet from rendered pages", async () => {
    const res = await app.fetch(new Request("http://localhost/"), makeEnv());
    expect(await res.text()).toContain(`href="${STYLESHEET_HREF}"`);
  });
});
