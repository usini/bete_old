# Contributing to Bete

Thanks for considering it. Bete is a small, deliberately simple project —
here's what keeps it that way, and how to send a PR.

## Ground rules

- **No build step, no bundler, no npm dependency on the client side.**
  `js/*` is plain ES modules imported directly by the browser
  (`import ... from './x.js?v=...'`). `server/` (the optional Raspberry Pi
  host) is the only part of the repo allowed a `package.json`. If your PR
  needs a client-side dependency, the answer is almost always "write the
  ~50 lines it would take instead" — that's the whole point of the project.
- **Vanilla JS, Canvas 2D.** No TypeScript, no framework, no CSS preprocessor.
- **The app is bilingual (French/English)** via `js/i18n.js`. Any new
  user-facing string needs an entry in both the `fr` and `en` dictionaries
  (missing keys fall back to English, so it won't crash, but please add both).
- Code comments, commit messages, and docs are in **English**. The `fr`
  dictionary in `js/i18n.js` (and `TUTORIAL_FR` in `js/tutorial.js`) are the
  one place French is expected.

## Running it locally

ES modules don't work over `file://`, so serve the folder:

```bash
python -m http.server 8000
# then open http://localhost:8000
```

No install step needed. See [`desktop/README.md`](desktop/README.md) and
[`android/README.md`](android/README.md) if you're touching the native
wrappers, and [`server/README.md`](server/README.md) for the Raspberry Pi host.

## Making a PR

- Keep PRs focused — one feature or fix at a time.
- Match the existing code style; don't refactor unrelated code in the same PR.
- No comments that just restate what the code does — only comment the parts
  where the *why* isn't obvious (a workaround, a hidden constraint).
- If your change touches any `js/*` file, run `node cachebust.mjs` before
  committing (bumps the `?v=` cache-buster on imports).
- Test on an actual browser — this project doesn't have an automated test
  suite, manual verification is what we've got.

## Good first issues

Small, self-contained starting points:
- Add a new UI language to `js/i18n.js` (one dictionary object + one `LANGS`
  entry — see the comments there).
- Anything tagged [`good first issue`](../../labels/good%20first%20issue) in
  the issue tracker.

## AI-assisted contributions welcome

This project is actively developed with [Claude Code](https://claude.com/claude-code) —
it would be a little ironic to turn away AI-assisted PRs. Use whatever tools
help you, AI or not. Just make sure you've actually read and understood the
diff you're submitting, and that it follows the ground rules above — a PR
that clearly wasn't reviewed by the person submitting it (unexplained
unrelated changes, invented APIs, ignored project conventions) will get
bounced back regardless of how it was produced.

## License

By contributing, you agree your contribution is licensed under the project's
[MIT license](LICENSE).
