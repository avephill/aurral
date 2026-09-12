# Working in this fork

This is Avery's fork of Aurral, running in production on Hayduke for real
people: Avery, and their dad, who reaches it as an installed desktop app called
Psalter. Treat it as software with users, not a sandbox.

## Every deploy gets its own version

Never build the image by hand. Use:

```
scripts/deploy.sh
```

It stamps the image with `git describe --tags --always --dirty`, which reads
like `v2.8.0-108-g31d6e133`: the upstream release this descends from, the
distance past it, and the exact commit. After deploying it asks the running app
what version it reports and fails if the answer is not the version just built,
so a deploy that silently kept the old image cannot pass unnoticed.

A build from an uncommitted tree is stamped `-dirty` and warns. That is allowed
for a quick test and unacceptable for anything Avery's dad will see: if someone
reports a bug, the version has to lead back to source that can be read.

The version surfaces at `/api/health` as `appVersion`, and in the UI. Passing
`APP_VERSION` at build time is what makes this work; the Dockerfile takes it as
a build arg and defaults to `unknown`, which is what a hand-built image reports.

Tag a release (`git tag vX.Y.Z`) when a batch of work is worth naming. Between
tags the describe string is enough to identify a deploy, so there is no need to
tag every commit.

## Deploy configuration lives outside the repo

`docker-compose.yaml` and the `.env` sit in the parent directory, not here.
Environment changes, like `SESSION_EXPIRY_HOURS`, belong there rather than in
committed defaults, because they describe this one installation.

## Local build and test gotchas

- `react-router-dom` is missing from the local `node_modules`, so any test that
  builds the whole app fails here and passes in Docker. Check whether a failure
  predates your change before chasing it.
- Frontend tests boot Vite. Run them with `--test-force-exit`, or a permission
  or resolve error inside Vite hangs the run instead of reporting anything.
- Verify CSS with lightningcss from `node_modules` rather than a full build.
