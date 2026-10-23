---
version: 1
slug: "docs-index-html"
primary_target: "docs/index.html"
related_targets: []
---

# Surface: project page (GitHub Pages)

Mode: Persuade (project landing page), in a documentation-index form. Static page served from
`main` `/docs` at paulmataruso.github.io/h6ai.

Audience: self-hosters looking for a file index, and h5ai users, equal weight. Job: understand
what h6ai is, see it, pick an install and follow its guide. Action: download the release / open
the install guide that fits. Proof: the user's screenshots (docs/*.png), the real numbers in
docs/PERFORMANCE.md, the audit and test suites. Tone (user's words): no selling, "just a fork of
h5ai that is modern, updated and more secure". No invented claims, users or testimonials.

Constraints: h6ai world from DESIGN.md (dark only, system fonts, three tonal planes, hairlines,
reserved accent for downloads, one gradient on the Download button and logo). Links to guides
point at the rendered GitHub files. Works without JavaScript; JS only adds copy buttons, the
download band and scroll-spy.

## Direction contract

THESIS: the project page is read like h6ai is used: a tree of sections on the left, one calm
reading column on the right, and the downloads behaving exactly like h6ai's own file rows. It
refuses the hero-headline-over-three-cards product page.

OWN-WORLD: Indigo Black ground, Indigo Night and Dusk planes, Slate hairlines, Frost White text,
Fog Grey secondary, Cornflower for links, focus and the current section, Lavender Violet only on
the release downloads, the blue-violet gradient only on the Download button and the logo. System
UI and mono stacks, tabular figures, 6/10/14px radii.

STORY: a visitor learns h6ai is a maintained, safer fork of h5ai, sees the real UI, picks native,
Docker or drop-in, copies the commands or downloads the release, and finds the full guide.

FIRST VIEWPORT: 56px top bar (mark, wordmark, Guides, Releases, GitHub). Left 264px section tree
styled as h6ai's folder tree, sticky. Right reading column (max 760px): "h6ai" title at display
scale beside the 64px mark, a two-sentence lead, a facts line (1.0.0, MIT, nginx + PHP 8.2), then
the release listing: two file rows with size-labelled download chips, the first unfolded into a
download band (Download button with size, curl line, Copy). The listing screenshot starts below.

FORM: documentation index, position 7 of 7 on my list, chosen by the user from the dealt hand;
seed:b68dbd17c2a8cbc3. Signature interaction: release rows unfold into the band and a started
download is stamped with h6ai's ticket; the tree tracks the section in view. Motion: h6ai's
grammar (150ms state, 180ms band, 320ms stamp), fades only under reduced motion.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
