// Runs in <head> before the page paints, so the chosen design applies with no
// flash. Kept as a file (not an inline <script>) so the Content-Security-Policy
// can forbid inline scripts entirely.
// Light-only for now (dark is still retired), but the design language is
// back to being a choice: Organic (default) or Modernist, restored from
// the stored preference pre-paint so there's no restyle flash.
document.documentElement.dataset.theme = 'light';
let design = 'organic';
try { design = localStorage.getItem('yoyoDesign') || 'organic'; } catch { /* ignore */ }
if (design !== 'modernist') design = 'organic';
document.documentElement.dataset.design = design;
