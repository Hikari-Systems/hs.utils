# lib/auth/ — implementation notes

## Pre-existing build state at the time this layer was added

`npm install && npm run build` is **clean** as of the start of this work
(commit 6e6b92a). No pre-existing TypeScript errors anywhere in `lib/`.

Earlier reports of `lib/service/edgar.ts(445,9)` / `(498,11)` `TS1005`
errors were transient artefacts of a missing `@tsconfig/node22` package
before `npm install` had been run. They do not reproduce after install.

If a build error appears in this folder later, it is from this layer and
should be fixed in this layer — it is not a pre-existing condition.
