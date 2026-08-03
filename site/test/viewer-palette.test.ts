// The palette seam, guarded at the one place it is VISIBLE — a rendered pill.
//
// `lifefile` names an accent ROLE per unit kind and holds no colour; the viewer
// resolves that role against the mounting life's palette. Both halves fail
// silently: a gene that re-introduced hex, or a mount whose palette never
// reached the renderer, would still paint a plausible pill — in somebody else's
// brand. Asserting on the emitted HTML is the only check that can tell.
import { describe, it, expect } from "vitest";
import { kindPill } from "../../.genome/viewer/src/pages-cells";
import type { ViewerConfig } from "../../.genome/viewer/src/config";

const mount = (palette?: ViewerConfig["palette"]) => ({ palette }) as ViewerConfig;

describe("kind pill palette", () => {
  it("wears the mount's palette, not the gene's", () => {
    const html = kindPill("gene", mount({ capability: "#123456" }));
    expect(html).toContain("#123456");
    expect(html).not.toContain("9FE0C4");
  });

  it("takes the gene's defaults for a key the mount does not set", () => {
    expect(kindPill("service", mount({ capability: "#123456" }))).toContain("#F0C674");
  });

  it("paints self and region from the same structural role", () => {
    const p = { structure: "#ABCDEF" };
    expect(kindPill("self", mount(p))).toContain("#ABCDEF");
    expect(kindPill("region", mount(p))).toContain("#ABCDEF");
  });
});
