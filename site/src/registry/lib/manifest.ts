/**
 * The normalized gene manifest the engine sends on publish.
 *
 * There is exactly ONE .life parser — the engine's (engine/lib/parser.js). The
 * genepool never parses a `.life` file; it stores the shape the engine already
 * computed. This type is that shape. (Files are still scanned + fit-checked
 * server-side, so the metadata can't lie its way past the gates.)
 */
export interface PublishManifest {
  summary: string | null;
  description: string | null;
  author: string | null;
  license: string | null;
  homepage: string | null;
  repository: string | null;
  keywords: string[];
  requires: string[]; // capabilities the gene needs
  provides: string[]; // capabilities it offers
  imports: string[];  // other genes it depends on (the gene network)
  inputs: string[];   // input keys gathered before install
  body: string | null; // markdown after the frontmatter
}
