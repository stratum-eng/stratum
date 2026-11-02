/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import { NAV_CSS } from "../src/ui/nav-css";
// @ts-expect-error - plain .mjs build script, no type declarations
import { readCommittedCss, renderHeaderCss } from "../website/scripts/mirror-header.mjs";

/**
 * The app and the docs site render one header, not two that look alike.
 *
 * `src/ui/nav-css.ts` owns it: the app splices it into `src/ui/styles.ts`, and
 * `website/scripts/mirror-header.mjs` copies it into the docs site's
 * `src/styles/header.css`, which `website/src/components/Header.astro` renders
 * the app's markup against. Nothing regenerates that copy at build time, so
 * without this test a change to the app's header would just quietly stop
 * reaching docs.usestratum.dev — which is how the two headers diverged before.
 *
 * The source files are read through Vite's raw glob rather than `node:fs`, so
 * the suite type-checks under the Workers tsconfig (same reason as
 * `migrations.test.ts`); the generated stylesheet comes back from the mirror
 * script, which is plain Node and reads it from disk.
 */
const files = import.meta.glob(
  ["../website/src/components/Header.astro", "../website/astro.config.mjs"],
  { query: "?raw", import: "default", eager: true },
) as Record<string, string>;

const read = (path: string): string => {
  const contents = files[`../website/${path}`];
  if (contents === undefined) throw new Error(`website/${path} was not globbed`);
  return contents;
};

describe("shared site header", () => {
  it("keeps the docs site's copy in sync with the app's", async () => {
    expect(await readCommittedCss()).toBe(await renderHeaderCss());
  });

  it("renders the app's own markup on the docs site", () => {
    const header = read("src/components/Header.astro");
    for (const className of ["nav", "nav-brand", "nav-auth", "nav-auth-link"]) {
      expect(NAV_CSS).toContain(`.${className}`);
      expect(header).toContain(`"${className}`);
    }
    // Starlight's own title component would reintroduce the header this
    // override exists to replace.
    expect(header).not.toContain("SiteTitle");
  });

  it("is wired into the docs site build", () => {
    const config = read("astro.config.mjs");
    expect(config).toContain('Header: "./src/components/Header.astro"');
    expect(config).toContain("./src/styles/header.css");
    // header.css carries the app's dark token values; theme.css remaps them for
    // the light theme, so it has to load after.
    expect(config.indexOf("./src/styles/header.css")).toBeLessThan(
      config.indexOf("./src/styles/theme.css"),
    );
  });
});
