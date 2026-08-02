# Local overlays

This fork tracks upstream NodeWarden, then re-applies a small local patch
instead of merging histories. That keeps automatic sync free of the
repeated merge conflicts caused by CronHub customizations.

## Files

- `cronhub.patch` — local changes on top of a clean upstream tree:
  - HTTP endpoint `POST /api/cron/scheduled-backup`
  - env binding `CRONHUB_TOKEN`
  - remove Cloudflare cron triggers from `wrangler.toml` (CronHub owns the schedule)
- `UPSTREAM_BASE` — upstream commit SHA this patch was last generated against

## Sync strategy

The `sync-upstream` workflow:

1. Resolves the target upstream release/commit
2. `git reset --hard` to that commit
3. Restores this `patches/` directory and the sync workflow
4. Applies `cronhub.patch`
5. Force-pushes `main`

## Refreshing the patch

If a future upstream release changes the patched hunks and auto-apply fails:

```bash
git fetch upstream --tags
git checkout -B main upstream/vX.Y.Z   # or the failed target
# re-introduce CronHub changes by hand
git diff upstream/vX.Y.Z -- src/index.ts src/types/index.ts wrangler.toml \
  > patches/cronhub.patch
git rev-parse upstream/vX.Y.Z > patches/UPSTREAM_BASE
git add patches src wrangler.toml .github/workflows/sync-upstream.yml
git commit -m "chore: refresh CronHub patch for upstream vX.Y.Z"
git push origin main --force-with-lease
```
