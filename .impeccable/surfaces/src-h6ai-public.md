---
version: 1
slug: "src-h6ai-public"
primary_target: "src/_h6ai/public"
related_targets: ["src/_h6ai/private/php/pages/page.php"]
---

# Surface brief: h6ai file index (listing, preview, admin)

Mode: Operate. Visitors of a public download archive find a file and get it downloading within seconds; admins pick the site theme.

Audience & job: deep-link visitors (often from Google) on desktop or phone wanting one, often huge, file; CLI users on the same URLs; anon download-only accounts; the admin.
Constraints: vanilla JS + plain CSS under a strict nonce CSP, no new dependencies, keyboard + screen reader, 35 languages (new strings fall back to English), dark only.
Memorable moment: the row that unfolds into "Download 7.5 GB · resumable" and the stamped confirmation after the click.
Unresolved: checksum line (declined for now).

## Direction contract

THESIS: The download is the hero. A file row unfolds in place into its download band instead of jumping to a page or a modal; the category default it refuses is "click = silent download" and "details in a modal".

OWN-WORLD: Familiar file-manager structure in five dark themes (Midnight default, Graphite, Deep Sea, Ember, OLED Black). Tinted neutrals, a link/focus colour, and one reserved accent per theme that only ever marks the download/selection path; the h6ai blue→violet gradient appears on the primary Download button and the logo, nowhere decorative.

STORY: Visitor sees where they are (breadcrumb, folder name), sees every file's size, clicks a name: media previews, anything else unfolds with an explicit "Download 7.5 GB" plus link and curl/wget; after any download starts a stamped confirmation says what started, how big, resumable.

FIRST VIEWPORT: top bar with h6ai mark + wordmark + site name, breadcrumb, grouped tools; details table full width with name, modified, size and a size-labelled download chip per file; parent row reads "Parent folder"; at most one expanded band directly under its row with the violet Download button left-aligned to the name column.

FORM: Inline row expansion, position 3 on the ordered list (1 inspector pane, 2 unified lightbox card, 3 inline row expansion, 4 bottom sheet, 5 file page, 6 download dock, 7 modal card); seed:d6ad488d296b9276. Raises: reserved download accent (orienteering map), stamped download states (ticket wallet).

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
