# Cumulant — brand

A typeset wordmark plus a restrained mark. Monochrome with one quiet accent.

## The system

- **Wordmark (the logo):** `CUMULANT` set in **Inter, weight 500, uppercase, ~0.3em tracking**.
- **Mark (favicon / avatar):** the **diagonal triad** — the correlation-matrix diagonal distilled to three points. The two outer points are the ink/bone color; the centre point is the deep-teal accent.
- **Voice:** institutional, not app-store. No tile, no gloss, no gradient.

## Color

| Token | Hex | Role |
| --- | --- | --- |
| Ink | `#14171A` | Wordmark + outer mark points, **light mode** |
| Bone | `#E8E6DF` | Wordmark + outer mark points, **dark mode** |
| Deep teal | `#2E5A52` | The single accent (centre mark point, optional wordmark dot) |
| Off-white | `#F7F6F2` | Light surface |

The ink/bone parts are driven by **`currentColor`**, so the logo is **black in light mode and white in dark mode** automatically — just set `color` on the element (or its parent). The teal accent is fixed. On very dark surfaces a lighter teal `#5E8C83` may be substituted for the accent if legibility needs it.

## Files

| File | Use |
| --- | --- |
| `cumulant-mark.svg` | The triad mark. `currentColor` outer points + teal centre. For inline/app use. |
| `cumulant-favicon.svg` | The triad as a favicon — self-adapts to the system light/dark theme via `prefers-color-scheme`. |
| `cumulant-wordmark.svg` | `CUMULANT` wordmark, `currentColor` live text. |
| `cumulant-lockup.svg` | Horizontal: mark + wordmark. |
| `cumulant-lockup-stacked.svg` | Vertical: mark over wordmark. |

## Using the wordmark on the web (recommended)

For crisp, theme-aware type, render the wordmark as **text**, not an image:

```css
.cumulant-logo {
  font-family: 'Inter', system-ui, sans-serif;
  font-weight: 500;
  font-size: 1.25rem;
  letter-spacing: 0.3em;
  text-transform: uppercase;
  color: currentColor;            /* black in light, white in dark */
}
/* optional single accent: the mean-dot */
.cumulant-logo::after {
  content: "";
  display: inline-block;
  width: 0.32em; height: 0.32em;
  border-radius: 50%;
  background: #2E5A52;
  margin-left: 0.28em;
  vertical-align: 0.12em;
}
```

```html
<span class="cumulant-logo">Cumulant</span>
```

## Favicon

Use `cumulant-favicon.svg` directly — it ships with a `prefers-color-scheme` rule so the points are ink on light browser chrome and bone on dark.

```html
<link rel="icon" href="/cumulant-favicon.svg" type="image/svg+xml">
```

## Notes

- **Clear space:** keep at least the cap-height of the wordmark around the lockup.
- **Minimum size:** the wordmark holds to ~80px wide; below that use the triad mark alone.
- **Production wordmark SVG:** `cumulant-wordmark.svg` uses live Inter text. Where Inter isn't guaranteed (PDFs, third-party embeds), convert the `<text>` to outlines in a vector editor.
- **Don't:** put the mark in a colored rounded tile, add gradients/shadows, or use the neon teal from earlier drafts — those read "app," not "desk."
