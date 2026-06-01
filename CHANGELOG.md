# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-06-01

Major rebrand: **ReplyMate → LinkMate**, first stable Chrome Web Store release.

### Added

- **SSI Tracker** — daily scrape of `/sales/ssi` into a local 90-snapshot ring
  buffer; trend chart + 4 component sub-metrics.
- **Engagement Queue** — feed relevance scoring with a "marked engaged" queue so
  handled posts aren't re-suggested.
- **Profile Context** — captures profile (headline, about, skills, themes) to
  personalize drafts in the user's own voice.
- **Multi-provider inference** — OpenAI (default) and Groq, both BYOK; provider
  abstraction in `src/providers/`.
- Profile Audit (All-Star completeness + activity signals), cadence/streak
  quotas, closed-loop outcome scanning.
- `PRIVACY.md` privacy policy and `docs/RELEASE.md` Chrome Web Store release guide.
- Tag-triggered release pipeline (`.github/workflows/release.yml`): type-check,
  lint, test, zip, GitHub Release, optional Chrome Web Store publish.

### Changed

- Renamed the extension and all branding from ReplyMate to LinkMate.

[1.0.0]: https://github.com/mrviduus/linkmate/releases/tag/v1.0.0
