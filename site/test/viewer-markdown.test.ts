import { describe, it, expect } from "vitest";
import { renderMarkdown, esc } from "../../.genome/viewer/src/markdown";

describe("viewer markdown", () => {
  it("renders the core blocks", () => {
    const html = renderMarkdown(
      "# Title\n\nA paragraph with **bold**, *em*, `code`, and a [link](https://x.dev).\n\n- one\n- two\n\n```js\nconst a = 1 < 2;\n```\n\n> quoted\n\n---\n",
    );
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>em</em>");
    expect(html).toContain("<code>code</code>");
    expect(html).toContain('<a href="https://x.dev" target="_blank" rel="noopener">link</a>');
    expect(html).toContain("<ul>");
    expect(html).toContain("const a = 1 &lt; 2;");
    expect(html).toContain("<blockquote>");
    expect(html).toContain("<hr>");
  });

  it("never lets raw HTML or bad schemes through", () => {
    const html = renderMarkdown('<script>alert(1)</script>\n\n[x](javascript:alert(1)) ![y](data:text/html,<b>)');
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("data:text/html");
  });

  it("resolves relative links and images through the caller", () => {
    const html = renderMarkdown("[kb](knowledge/foo.md) ![img](../pic.png)", {
      resolveLink: (h) => `/app/o/r/life/${h}`,
      resolveImage: (s) => `/app/o/r/raw/${s}`,
    });
    expect(html).toContain('href="/app/o/r/life/knowledge/foo.md"');
    expect(html).toContain('src="/app/o/r/raw/../pic.png"');
    // absolute stays untouched
    const abs = renderMarkdown("[x](https://a.b)", { resolveLink: () => "NOPE" });
    expect(abs).toContain('href="https://a.b"');
  });

  it("renders tables", () => {
    const html = renderMarkdown("| a | b |\n|---|---|\n| 1 | 2 |");
    expect(html).toContain("<th>a</th>");
    expect(html).toContain("<td>2</td>");
  });

  it("escapes html metacharacters", () => {
    expect(esc(`<a b="c">&'`)).toBe("&lt;a b=&quot;c&quot;&gt;&amp;&#39;");
  });
});
