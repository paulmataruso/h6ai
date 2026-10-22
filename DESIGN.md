---
name: h6ai
description: A fast, dark, file-manager-familiar index for public download archives, where the download is the hero.
colors:
  indigo-black: "#0b0d14"
  indigo-night: "#11141e"
  indigo-dusk: "#181c29"
  slate-hairline: "#232838"
  slate-rule: "#353d54"
  slate-input-edge: "#5c6584"
  frost-white: "#e8eaf2"
  fog-grey: "#a3aabd"
  pewter-grey: "#8d94a9"
  hover-veil: "rgba(232,234,242, 0.06)"
  pressed-veil: "rgba(232,234,242, 0.10)"
  cornflower-link: "#82a8ff"
  cornflower-soft: "rgba(130,168,255, 0.14)"
  cornflower-action: "#82a8ff"
  cornflower-action-hover: "#91b2ff"
  lavender-violet: "#a98dfb"
  lavender-violet-hover: "#b39bfb"
  lavender-violet-soft: "rgba(169,141,251, 0.16)"
  ink-violet: "#140a33"
  selection-wash: "rgba(169,141,251, 0.18)"
  selection-edge: "rgba(169,141,251, 0.55)"
  gradient-cobalt: "#3c60e4"
  gradient-violet: "#7a4fe0"
  logo-azure: "#4c8dff"
  logo-violet: "#8b5cf6"
  pure-white: "#ffffff"
  coral-red: "#ff6b63"
  leaf-green: "#4cc96a"
  ochre-amber: "#e3ad3c"
typography:
  headline:
    fontFamily: "system-ui, -apple-system, \"Segoe UI\", Roboto, \"Helvetica Neue\", Arial, \"Noto Sans\", sans-serif"
    fontSize: "1.5rem"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "-0.005em"
  title:
    fontFamily: "system-ui, -apple-system, \"Segoe UI\", Roboto, \"Helvetica Neue\", Arial, \"Noto Sans\", sans-serif"
    fontSize: "1.25rem"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "-0.005em"
  title-card:
    fontFamily: "system-ui, -apple-system, \"Segoe UI\", Roboto, \"Helvetica Neue\", Arial, \"Noto Sans\", sans-serif"
    fontSize: "1.125rem"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "-0.005em"
  wordmark:
    fontFamily: "system-ui, -apple-system, \"Segoe UI\", Roboto, \"Helvetica Neue\", Arial, \"Noto Sans\", sans-serif"
    fontSize: "1rem"
    fontWeight: 700
    lineHeight: 1.5
    letterSpacing: "-0.02em"
  body:
    fontFamily: "system-ui, -apple-system, \"Segoe UI\", Roboto, \"Helvetica Neue\", Arial, \"Noto Sans\", sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "0.005em"
    fontFeature: "\"tnum\""
  button:
    fontFamily: "system-ui, -apple-system, \"Segoe UI\", Roboto, \"Helvetica Neue\", Arial, \"Noto Sans\", sans-serif"
    fontSize: "0.875rem"
    fontWeight: 600
    lineHeight: 1.2
  small:
    fontFamily: "system-ui, -apple-system, \"Segoe UI\", Roboto, \"Helvetica Neue\", Arial, \"Noto Sans\", sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "system-ui, -apple-system, \"Segoe UI\", Roboto, \"Helvetica Neue\", Arial, \"Noto Sans\", sans-serif"
    fontSize: "0.75rem"
    fontWeight: 600
    lineHeight: 1.5
    letterSpacing: "0.05em"
  mono:
    fontFamily: "ui-monospace, SFMono-Regular, \"SF Mono\", Menlo, Consolas, \"Liberation Mono\", monospace"
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: 1.5
rounded:
  sm: "6px"
  md: "10px"
  lg: "14px"
  pill: "999px"
spacing:
  s-1: "4px"
  s-2: "8px"
  s-3: "12px"
  s-4: "16px"
  s-5: "24px"
  s-6: "32px"
  s-7: "48px"
  s-8: "64px"
  target: "36px"
  target-coarse: "44px"
components:
  button-download:
    backgroundColor: "{colors.gradient-cobalt}"
    textColor: "{colors.pure-white}"
    typography: "{typography.button}"
    rounded: "{rounded.sm}"
    padding: "0 24px 0 16px"
    height: "40px"
  button-primary:
    backgroundColor: "{colors.cornflower-action}"
    textColor: "{colors.indigo-black}"
    typography: "{typography.button}"
    rounded: "{rounded.sm}"
    padding: "0 16px"
    height: "36px"
  button-primary-hover:
    backgroundColor: "{colors.cornflower-action-hover}"
  button-secondary:
    backgroundColor: "{colors.indigo-dusk}"
    textColor: "{colors.frost-white}"
    rounded: "{rounded.sm}"
    padding: "0 16px"
    height: "36px"
  download-chip:
    textColor: "{colors.fog-grey}"
    rounded: "{rounded.sm}"
    padding: "0 8px"
    height: "28px"
  download-chip-intent:
    backgroundColor: "{colors.lavender-violet-soft}"
    textColor: "{colors.lavender-violet}"
  download-chip-hover:
    backgroundColor: "{colors.lavender-violet}"
    textColor: "{colors.ink-violet}"
  archive-download-action:
    backgroundColor: "{colors.lavender-violet-soft}"
    textColor: "{colors.lavender-violet}"
    rounded: "{rounded.sm}"
    padding: "0 12px"
    height: "36px"
  row-selected:
    backgroundColor: "{colors.selection-wash}"
    textColor: "{colors.frost-white}"
    rounded: "{rounded.sm}"
  download-band:
    backgroundColor: "{colors.indigo-night}"
    rounded: "{rounded.md}"
    padding: "16px"
  download-stamp:
    backgroundColor: "{colors.indigo-dusk}"
    textColor: "{colors.frost-white}"
    rounded: "{rounded.sm}"
    height: "44px"
  download-stamp-stub:
    backgroundColor: "{colors.lavender-violet-soft}"
    textColor: "{colors.lavender-violet}"
    padding: "0 12px"
  download-notice:
    backgroundColor: "{colors.indigo-dusk}"
    textColor: "{colors.frost-white}"
    rounded: "{rounded.md}"
    padding: "0 8px 0 0"
  text-field:
    backgroundColor: "{colors.indigo-black}"
    textColor: "{colors.frost-white}"
    rounded: "{rounded.sm}"
    padding: "0 12px"
    height: "36px"
  chip:
    backgroundColor: "{colors.indigo-dusk}"
    textColor: "{colors.fog-grey}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "1px 8px"
  topbar:
    backgroundColor: "{colors.indigo-night}"
    height: "56px"
    padding: "0 12px 0 16px"
  dialog:
    backgroundColor: "{colors.indigo-night}"
    textColor: "{colors.frost-white}"
    rounded: "{rounded.lg}"
    width: "min(460px, calc(100vw - 32px))"
  admin-card:
    backgroundColor: "{colors.indigo-night}"
    rounded: "{rounded.lg}"
    padding: "24px"
---

# Design System: h6ai

## Overview

**Creative North Star: "The Download Counter"**

A well-lit counter in a dark archive. The room is quiet and familiar: a top bar, a breadcrumb, a full-width details table with name, modified date and size, the shape every visitor already knows from a file manager. The light falls on one place only, the counter where a file is handed over. Every file states its size plainly in a chip at the end of its row; clicking a name unfolds the row in place into a band that says "Download 7.5 GB" on the one gradient button in the interface, with the direct link, curl and wget beneath it; once a download starts, a ticket is stamped right where the button was, saying when it started, how big it is, and that it is resumable, and the button steps back to a quiet "Download again". Downloads started anywhere else get the same ticket as a receipt at the bottom of the screen.

This is an Operate surface. Density is product-UI density: a 14px body, 36px rows and controls (44px on touch), a 4px spacing grid, hairline borders between tinted near-black planes. The brand lives in precise details rather than spectacle: the h6ai hexagon and wordmark in the top bar, one reserved accent colour per skin that marks only the download and selection path, and the blue-to-violet gradient that belongs to the logo and the Download button. Everything else is neutral and recedes.

The system is dark only, shipped as five generated, AA-checked skins (Midnight by default, Graphite, Deep Sea, Ember, OLED Black). It uses the platform's system font stack and loads no web fonts. Icons are inline stroke SVG that follow the text colour. Nothing is decorative: no gradient text, no eyebrow labels, no coloured side stripes, no glyph icons.

**Key Characteristics:**
- Familiar file-manager structure; the brand shows up in the download path, not in ornament.
- Tinted near-black planes separated by 1px hairlines; depth by tone first, shadow second.
- One reserved accent per skin, spent only on download and selection.
- One gradient, on the primary Download button and in the logo.
- System fonts, tabular numerals, 14px body, 36px minimum targets (44px on coarse pointers).
- Five dark skins with identical structure; colours are swapped wholesale via the skin attribute.
- Every started download is stamped with a ticket: accent stub, dashed perforation, what and how big.

## Colors

Tinted near-black neutrals carry the whole interface; a cornflower blue handles links, focus and ordinary primary actions; a lavender violet (in Midnight) is held back for the download and selection path alone.

### Primary
- **Lavender Violet** (#a98dfb): the reserved download/selection accent. The download chip's icon at rest and the whole chip on intent, the archive "Download N items" action, the stamped ticket's border, stub and perforation (in the band and in the bottom notice), the selection checkbox fill, the "download" access-level chip and the file and archive download chips in the activity log, and the miniature chip, row and button in the admin theme previews. Its soft wash (Lavender Violet Soft) backs the chip and the archive action; Selection Wash and Selection Edge paint selected rows. Ink Violet (#140a33) is the text that sits on a solid accent fill.
- **Gradient Cobalt to Gradient Violet** (#3c60e4 to #7a4fe0, 135 degrees): the brand gradient as worn by the Download button, deepened from the logo stops so Pure White (#ffffff) text clears AA. Each skin carries its own accent gradient on this button: blue to violet in Midnight, Graphite and OLED Black, sea teal in Deep Sea, amber to rust in Ember.
- **Logo Azure to Logo Violet** (#4c8dff to #8b5cf6): the logo's own gradient, fixed across every skin and used only inside the logo artwork.

### Secondary
- **Cornflower Link** (#82a8ff): links, focus rings, the text caret, text selection (as Cornflower Soft), and the "on" state of settings controls: active switch track, checked radio cards, active tab underline, native checkbox and range tint, the site-default theme card.
- **Cornflower Action** (#82a8ff, hover #91b2ff): the fill of primary buttons outside the download path (Log in, Save, Add user, Check). It shares the link's hue in every skin but is a separate token so the two roles can diverge.

### Neutral
- **Indigo Black** (#0b0d14): page ground, input ground, the sticky column header.
- **Indigo Night** (#11141e): first raised plane. Top bar, expansion band, dialogs, menus, admin cards, grid-view tiles.
- **Indigo Dusk** (#181c29): second raised plane. Secondary buttons, chips, the stamped notice, the segmented control track, thumbnails.
- **Slate Hairline** (#232838): every 1px divider and container edge.
- **Slate Rule** (#353d54): stronger edges, hovered tiles, keycap borders.
- **Slate Input Edge** (#5c6584): field and button borders and the off switch track, at least 3:1 against the ground.
- **Frost White** (#e8eaf2): primary text.
- **Fog Grey** (#a3aabd): secondary text, column headers, the resting download chip, field labels.
- **Pewter Grey** (#8d94a9): faint text and placeholders, still at least 4.5:1.
- **Hover Veil / Pressed Veil** (6% / 10% of Frost White): row and tool hover and pressed states.

### Status
- **Coral Red** (#ff6b63), **Leaf Green** (#4cc96a), **Ochre Amber** (#e3ad3c): danger, success, warning; each has a 14-15% soft wash for banners and chips. They also colour code tokens in previews.

### Skins
Midnight is normative for the tokens above. Graphite (neutral charcoal, zero tint), Deep Sea (teal-navy, sea-teal accent), Ember (umber-black, amber accent, steel-blue links so amber stays exclusive to downloads) and OLED Black (true black) redefine the same custom properties under the skin attribute; their values are recorded in the sidecar. Structure, type, spacing and shape never change between skins.

### Named Rules
**The Reserved Accent Rule.** The accent and its soft wash mark only the download and selection path: the size-labelled download chip, the band's Download button, the archive "Download N items" action, the stamped ticket in the band and in the notice, selected rows with their checkboxes, and the admin's representations of downloads (the "download" level chip, file and archive download events, the theme-preview miniatures). If a new element is not a download, an archive download, or a selection, it does not get the accent; no skin may reuse its accent hue for links.

**The One Gradient Rule.** The brand gradient appears in exactly two places: the primary Download button, which wears the skin's accent gradient, and the logo, which keeps the fixed azure to violet in every skin. The admin theme previews may draw both in miniature. No gradient backgrounds, borders, dividers or text anywhere else; once a download has started, the button gives up the gradient.

**The Link-and-Focus Rule.** Cornflower Link is the colour of links, focus rings and the caret, and of "this setting is on". It never marks a download.

**The Second Voice Rule.** Primary buttons outside the download path (log in, save, add, check) fill with Cornflower Action. A violet or gradient Save button is a bug.

**The Dark Only Rule.** Every surface is dark. New skins are new dark palettes on the same tokens, generated and checked for 4.5:1 text and accent contrast on every plane and 3:1 for input borders. There is no light mode.

## Typography

**Display Font:** none. The largest type is a 24px headline.
**Body Font:** the system UI stack (system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, Noto Sans, sans-serif)
**Label/Mono Font:** the system monospace stack (ui-monospace, SF Mono, Menlo, Consolas, Liberation Mono) for links, curl/wget commands, code and keycaps.

**Character:** the operating system's own voice, so the index feels native on every device and costs no bytes. A compact product scale with a ratio of about 1.2 around a 14px body; slightly loosened tracking for light-on-dark legibility and tabular numerals so sizes and dates align in columns.

### Hierarchy
- **Headline** (600, 24px, 1.25): the admin page title only.
- **Title** (600, 20px, 1.25): dialog headings.
- **Title Card** (600, 18px, 1.25): admin card and section headings.
- **Wordmark** (700, 16px, -0.02em): the "h6ai" wordmark in the top bar; 16px also serves empty-state and preview headings.
- **Body** (400, 14px, 1.5, +0.005em, tabular numerals): file names, rows, menus, everything by default. Help text and descriptions cap at a 72ch measure.
- **Button** (500 on secondary, 600 on primary and Download, 14px, 1.2): button labels.
- **Small** (400, 13px): band line labels, ticket metadata (tabular), help text, small buttons, range labels.
- **Label** (600, 12px, +0.05em, uppercase): column headers of the details table, admin tables and the fallback listing, drawer group headings and admin list headings, all on one shared caps tracking. These name the column or group they sit on; they are never a kicker above another heading. Non-uppercase 12px 600 labels name form fields.
- **Mono** (13px): the direct link and curl/wget commands in the band, inline code, keycaps at 0.85em.

### Named Rules
**The System Stack Rule.** No web fonts. Type comes from the system UI and monospace stacks; the strict CSP and the "fast on any device" promise both depend on it.

**The Tabular Numbers Rule.** Numerals are tabular everywhere, so sizes, dates, counts and ticket times line up down a column.

## Layout

The index is a full-height app frame: a 56px top bar (brand, breadcrumb, grouped tools), then the listing at full width, with an optional folder tree on the left (260px, off by default) and optional right-hand drawers for file info and settings (288px each). The details view is a four-column grid: icon, name (flexible), modified (168px), size (128px), with a sticky column header. Rows are at least 36px; files show their size inside the download chip and leave the size cell empty. Once a band's download starts, the ticket takes the head's first slot and "Download again" follows it. The expansion band appears directly under its row, indented to the name column so the Download button lines up with the file name; in grid and icon views it spans the full row of tiles. Grid and icon views are auto-fill grids with an 8px gap whose cell size follows the size slider.

The admin page is a centred column (max 1120px) with a header, a tab bar and stacked cards.

Spacing follows a 4px grid: 4, 8, 12, 16, 24, 32, 48, 64. Controls are at least 36px, 44px on coarse pointers; the Download button is 40px (48px on touch). Toolbar tool groups are separated by a 1px, 20px-tall hairline.

Responsive behaviour:
- **1080px and below:** the info panel is removed.
- **720px and below:** the folder tree is removed (the breadcrumb is the navigation), the operator's site name hides while the h6ai mark and wordmark stay, the archive action collapses to its icon, the settings drawer overlays from the right at min(88vw, 340px) with a shadow, the filter input narrows to 120px and the breadcrumb keeps only the current folder while typing.
- **560px and below:** the band stacks (Download and close on one line, note beneath; once started, ticket and close on the first line, "Download again" on the second; link labels above their values, commands wrap instead of scrolling); the stamped notice spans the screen width.
- **360px and below:** the wordmark hides and the logo mark alone carries the brand.
- **Coarse pointers:** targets grow to 44px, rows to 48px, the selection box to 22px. With no hover, checkboxes and download chips are always visible.

### Named Rules
**The Four Thresholds Rule.** Responsive changes happen at 560px, 720px, 1080px and on pointer: coarse (plus hover: none for always-visible affordances). The single exception is 360px, reserved for the brand: below it the wordmark gives way to the mark. Do not add new breakpoints for a single component.

**The Target Rule.** Nothing interactive is smaller than 36px, or 44px on a coarse pointer.

## Elevation & Depth

Depth is tonal first: the page ground, a first raised plane and a second raised plane, separated by 1px hairlines. Shadows are reserved for two jobs: lifting the in-flow download surfaces off the list, and floating overlays above it. Focus and selection are drawn with rings, not lifts.

### Shadow Vocabulary
- **Raised in-flow** (`box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3)`): the expansion band and the Download button only.
- **Floating** (`box-shadow: 0 12px 32px rgba(0, 0, 0, 0.55)`): dialogs, the account menu, notifications, the stamped bottom notice, the preview chrome, the narrow-screen settings drawer.
- **Nub** (`box-shadow: 0 1px 2px rgba(0, 0, 0, 0.45)`): the active segment of a segmented control and the switch thumb.
- **Focus halo** (`box-shadow: 0 0 0 3px` Cornflower Soft): focused text fields and the open filter input, paired with a Cornflower border. Other focus is a 2px Cornflower outline at 2px offset.
- **Selection ring** (`box-shadow: inset 0 0 0 1px` Selection Edge): selected rows, over Selection Wash.

### Named Rules
**The Raised Path Rule.** Only the download path is lifted inside the page flow. Cards, tiles and rows stay flat.

## Shapes

Gently rounded, never pill-shaped except for status chips. Three radii: 6px for controls, rows, chips in the list, fields, code wells and the in-band ticket; 10px for the band, menus, notifications, the stamped notice and theme cards; 14px for dialogs and admin cards. Status chips are full pills; the selection checkbox and segment buttons use 5px, keycaps 4px. Containers are drawn with 1px hairline borders; inputs and buttons use the stronger input edge. The ticket is the one recurring silhouette of its own: an accent-bordered box with a stub on the accent wash, separated from the body by a 1px dashed accent perforation. The only hard-white shape is the QR code plate, which must stay white to scan.

## Components

### Buttons
Quiet, compact, and unambiguous about which one starts a download.
- **Shape:** gently rounded (6px), 36px tall (44px on touch), 16px side padding, 500 weight.
- **Download:** the skin's accent gradient at 135 degrees with white 600-weight text, a download icon and the size in the label ("Download 7.5 GB"), 40px tall (48px on touch), 16px/24px padding, borderless, with the raised in-flow shadow. Hover brightens by 8%. Used in the band and in the preview's "cannot preview" state. After the click the same link drops the gradient and becomes a secondary button reading "Download again".
- **Primary (non-download):** Cornflower Action fill with ink text at 600 weight; hover steps to the lighter action tone.
- **Secondary:** Indigo Dusk fill with an input-edge border; hover lightens the border to Pewter.
- **Small:** 30px (40px on touch), 12px padding, 13px text: Copy, Show QR code, Copy link.
- **Icon and bar buttons:** transparent, Fog Grey icon, 36px square; hover shows the hover veil and Frost White.
- **Danger:** neutral at rest, Coral wash and text on hover.

### Download Chip (signature)
Each file row ends in a chip that states the file's size. At rest it shows the size in Fog Grey with its 15px download icon in the accent at 75% opacity; on row hover, focus or expansion it takes the accent wash and accent text and the icon goes fully opaque; on its own hover it fills solid with the accent and ink text. 28px tall, 6px radius, 8px padding. On touch it is always accent-coloured with the icon visible. In very narrow listings it collapses to an icon-only 36px target.

### Expansion Band (signature)
The row unfolds in place into a raised card: first raised plane, 1px hairline, 10px radius, 16px padding, raised in-flow shadow, indented to the name column. Head: the Download button, a muted note ("Resumable · modified ..."), a close button at the far right. Below: a definition list of Direct link, curl and wget, each a 13px monospace command in a page-ground well with a small Copy button. Foot: Show QR code. It enters with a 180ms fade and 4px drop on the out-easing; at most one band is open. When its Download is clicked the band is stamped (see the ticket below).

### Stamped Ticket (signature)
The receipt for a started download, in one form wherever it appears: second raised plane, 1px accent border; a stub on the accent wash holding the icon in accent; a 1px dashed accent perforation; then a body with the title in 600 weight and the metadata in Fog Grey 13px tabular figures.
- **In the band:** stamped in front of the button after the click: "Download started", "HH:MM · 7.5 GB · resumable", 6px radius, at least 44px tall, check icon. It lands with a 320ms stamp on the out-easing (from 112% scale and a 2-degree tilt, overshooting slightly, settling flat); a second click restamps it. This is the system's one authored motion moment.
- **As the bottom notice:** for downloads started outside a band (the row chip, single-click modes, archives, the preview's fallback link): bottom centre, 10px radius, floating shadow, plus Copy link and dismiss. The check icon is stamped when started; a download icon pulses while an archive is preparing. Archive metadata reads "N items · size · .tar · streaming, not resumable". It enters with a 220ms fade and 8px rise.

### Archive Download Action
When rows are selected, the toolbar shows a labelled tool, "Download N items · size · .tar", with an accent border, accent wash and accent text at 600 weight; hover fills it solid with ink text. Below 720px it collapses to its icon.

### Rows and Selection
Rows are 6px-rounded, transparent at rest, hover veil on hover and while expanded. Selected rows take Selection Wash with a 1px inset Selection Edge ring; the checkbox (18px, 5px radius, 22px on touch) appears on hover and fills with the accent when selected. The parent row reads "Parent folder". Grid tiles sit on the first raised plane with a hairline that strengthens on hover.

### Chips
- **Style:** full pills, 12px 500-weight text, 1px/8px padding, Indigo Dusk with Fog Grey by default.
- **State:** soft-wash variants by meaning: Cornflower for informational and "read", Ochre for warning and "list", Coral for "none", the accent only for "download".

### Cards / Containers
- **Corner Style:** 14px for admin cards and dialogs, 10px for theme cards, menus and notices. Admin cards pad 24px; the theme gallery fits five cards across (min 176px each), each preview framed in the page ground.
- **Background:** the first raised plane.
- **Shadow Strategy:** cards are flat; dialogs, menus and notices float (see Elevation & Depth).
- **Border:** 1px hairline; the site-default theme card's border turns Cornflower.
- **Internal Padding:** dialogs 24px with 16px bottom; theme cards 12px.

### Inputs / Fields
- **Style:** page-ground fill, 1px input-edge border, 6px radius, 36px tall, 12px side padding; 12px 600 Fog Grey label above with a 6px gap; help text in 13px Fog Grey at 72ch.
- **Focus:** border turns Cornflower with a 3px Cornflower Soft halo; no outline.
- **Read-only:** Fog Grey text on the second raised plane.
- **Error:** dialog errors sit in a 6px-rounded Coral wash with Coral text.
- **Radio cards:** a bordered 6px card per option; the checked card takes a Cornflower border and Cornflower Soft wash.
- **Filter rows:** admin activity filters sit on one row in the shared field style: two selects, then the path input taking the rest.

### Navigation
- **Top bar:** 56px, first raised plane, hairline beneath. Left: the 28px logo mark, the 16px 700 wordmark, the site name in Fog Grey after a slash, closed by a hairline. Then the breadcrumb. Right: tool groups (find, output, preferences, account), 36px transparent tools with 6px radius, hover veil, pressed veil when active, hairline separators between visible groups. Filter and search are icon tools that expand into a 220px input with a Cornflower focus halo.
- **Admin tabs:** icon and label, Fog Grey at rest, Frost White on hover, active tab gets a 2px Cornflower underline; on narrow screens the bar scrolls sideways under a fading mask.
- **Settings drawer:** 288px column with uppercase group headings, a segmented control for views, theme swatches (four-colour chip strips; the active swatch gets the second plane and a strong border), and switches (36x20 track, Cornflower when on).

### Motion
Short and functional, on two curves: a standard ease (cubic-bezier(.2, .7, .2, 1)) for state changes at 120-150ms and an out-ease (cubic-bezier(.16, 1, .3, 1)) for arrivals: dialogs and notifications 160ms, the band 180ms, the stamped notice 220ms, the filter input 200ms. The one authored moment is the 320ms ticket stamp; nothing else rotates or overshoots.

**The Still Motion Rule.** Under reduced motion nothing travels or scales: the band, the ticket stamp, dialogs, notices and preview simply fade in 120ms, busy pulses stop at 60% opacity, and only the preview spinner keeps turning, slowly.

### Named Rules
**The No Decoration Rule.** No gradient text, no eyebrow or kicker labels above headings, no coloured side-stripe borders, no glyph or emoji icons. Every UI icon is an inline 24-unit stroke SVG with 2px round strokes in currentColor from the shared icon set.

**The Receipt Rule.** Every download that starts gets exactly one stamped ticket, in the band when it started there and as the bottom notice otherwise: what started, how big, and whether it resumes.

## Do's and Don'ts

### Do:
- **Do** give every file row a size-labelled download chip, and label the Download button with the size ("Download 7.5 GB").
- **Do** stamp a started download with the ticket form (accent stub, dashed accent perforation, tabular metadata) and demote the button to "Download again".
- **Do** spend the accent only on the download and selection path, and Cornflower only on links, focus, primary non-download actions and "on" states.
- **Do** keep new screens on the three tonal planes with 1px hairlines; lift only the band and the Download button, float only overlays.
- **Do** use the 4px spacing scale and the 6/10/14px radii, and keep every target at 36px (44px on coarse pointers).
- **Do** take colours from the skin tokens so a new component works in all five dark skins unchanged.
- **Do** use the system font stacks with tabular numerals, and cap prose and help text at 72ch.
- **Do** honour reduced motion: fade, don't travel.

### Don't:
- **Don't** put the accent or its wash on anything that is not a download, an archive download or a selection.
- **Don't** use the brand gradient anywhere except the primary Download button and the logo; never on text, borders or backgrounds.
- **Don't** add a light theme or light surfaces.
- **Don't** load web fonts.
- **Don't** add eyebrow or kicker labels above headings, coloured side-stripe borders, gradient text, or glyph and emoji icons.
- **Don't** introduce breakpoints beyond 560px, 720px, 1080px and pointer: coarse.
- **Don't** give cards, tiles or rows a resting shadow.
- **Don't** add another rotating, overshooting or stamping animation; the ticket stamp is the only one.
