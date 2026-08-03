// The gene face has TWO tiers on this face too.
//
// The viewer rendered the glyph tile alone for months, so the same gene wore the
// pool's published art on a phone and a hash-tinted glyph on the web — a
// divergence no transcription check could catch, because the tier that was
// missing had never been written down to transcribe. These assert both tiers are
// present and that the art URL is DERIVED from the name.
import { describe, it, expect } from "vitest";
import { geneTile, geneIconUrl } from "../../.genome/viewer/src/pages-genes";

describe("gene tile", () => {
  it("draws the pool's art over the glyph", () => {
    const html = geneTile("secrets", 48);
    expect(html).toContain('src="https://known.life/secrets/icon"');
    expect(html).toContain("gn-tile");
    expect(html).toContain("<ion-icon"); // the glyph underneath, always rendered
  });

  it("gives the art an empty alt, so a 404 paints nothing over the glyph", () => {
    expect(geneTile("secrets", 48)).toContain('alt=""');
  });

  it("derives the art URL and escapes a name that needs it", () => {
    expect(geneIconUrl("claude-code")).toBe("https://known.life/claude-code/icon");
    expect(geneTile("a b", 32)).toContain("a%20b/icon");
  });
});
