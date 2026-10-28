# FIX18 — Share UI, music startup, responsive level map

- Redesigned the WeChat Mini Program share CTA as a prominent gradient invitation card.
- Fixed the music preference migration: fresh installs default to music enabled, and users previously affected by the old migration that forcibly turned music off are restored to enabled once. Explicit future opt-outs are respected.
- Retries background music when the app returns to the foreground and when the home page appears.
- Replaced over-compressed narrow-screen map styles with responsive spacing and readable labels.
- Improved the web adventure map's node sizing and map height across desktop and mobile widths.

Browser audio autoplay can still be blocked by browser policy until a user gesture. The web app retries on interaction; please verify playback on target devices.
