// The Claude Code marketplace entry must install the plugin from a release, never from the
// default branch. With a relative-path source, `/plugin install` copied plugins/claude-code from
// whatever main held, so client code merged for the next release reached new installs before
// it was released. The entry is a `git-subdir` source pinned to a release tag and that
// tag's full commit sha; Claude Code checks out the sha, so a tag moved later changes nothing.
//
// The pin moves in a pull request opened right after each release is tagged (CONTRIBUTING.md,
// "Releasing"). check-versions.mjs calls pinErrors with the repository's real tags, so CI fails
// while the pin lags the latest release.

/** The fields of the entry's source that never change from one release to the next. */
export const PINNED_SOURCE = Object.freeze({
  source: "git-subdir",
  url: "https://github.com/distronode-corporation/worldinmotion.git",
  path: "plugins/claude-code",
});

const RELEASE_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;
const SHA = /^[0-9a-f]{40}$/;
const KEYS = new Set([...Object.keys(PINNED_SOURCE), "ref", "sha"]);

const parts = (name) => RELEASE_TAG.exec(name).slice(1).map(Number);

/**
 * The newest `vX.Y.Z` tag in `tags`, compared as numbers. Other tags are ignored.
 * @param {{ name: string, commit: string }[]} tags
 */
export function latestRelease(tags) {
  let best;
  for (const tag of tags) {
    if (!RELEASE_TAG.test(tag.name)) continue;
    if (best === undefined) {
      best = tag;
      continue;
    }
    const [a, b] = [parts(tag.name), parts(best.name)];
    const i = a.findIndex((n, k) => n !== b[k]);
    if (i !== -1 && a[i] > b[i]) best = tag;
  }
  return best;
}

/**
 * What is wrong with the marketplace entry's pin, or nothing.
 * @param {unknown} entry the plugin entry from .claude-plugin/marketplace.json
 * @param {{ name: string, commit: string }[]} releases the release tags on commits before this
 *   one, each with the commit it names; the tag of the commit being checked is left out, because
 *   the pin can only move after its tag exists
 * @returns {string[]}
 */
export function pinErrors(entry, releases) {
  const where = ".claude-plugin/marketplace.json plugins[0].source";
  const source = entry?.source;
  if (typeof source !== "object" || source === null || Array.isArray(source)) {
    return [
      `${where} is ${JSON.stringify(source)}: it must be a git-subdir source pinned to a release, ` +
        "because a relative path installs the plugin from the default branch",
    ];
  }

  const errors = [];
  for (const [key, value] of Object.entries(PINNED_SOURCE)) {
    if (source[key] !== value) errors.push(`${where}.${key} is ${JSON.stringify(source[key])}, expected ${JSON.stringify(value)}`);
  }
  for (const key of Object.keys(source)) {
    if (!KEYS.has(key)) errors.push(`${where}.${key} is not allowed: the source is ${[...KEYS].join(", ")} and nothing else`);
  }
  if (typeof source.ref !== "string" || !RELEASE_TAG.test(source.ref)) {
    errors.push(`${where}.ref is ${JSON.stringify(source.ref)}: it must be a release tag, vX.Y.Z`);
  }
  if (typeof source.sha !== "string" || !SHA.test(source.sha)) {
    errors.push(`${where}.sha is ${JSON.stringify(source.sha)}: it must be the tag's full 40-character lowercase commit sha`);
  }
  if (errors.length > 0) return errors;

  const latest = latestRelease(releases);
  if (latest === undefined) {
    return [
      `${where}: no release tag vX.Y.Z is visible before this commit, so the pin cannot be checked. ` +
        "The check needs the tags and history (actions/checkout with fetch-depth: 0, or git fetch --tags).",
    ];
  }
  if (!releases.some((tag) => tag.name === source.ref)) {
    return [
      `${where}.ref is ${source.ref}, which is not a release tag before this commit (the latest is ${latest.name}): ` +
        "the pin moves only after its release is tagged",
    ];
  }
  if (source.ref !== latest.name) {
    return [
      `${where}.ref is ${source.ref}, but the latest release before this commit is ${latest.name}: ` +
        `move the pin to ${latest.name} and ${latest.commit} (the post-tag pull request)`,
    ];
  }
  if (source.sha !== latest.commit) {
    return [`${where}.sha is ${source.sha}, but ${latest.name} is commit ${latest.commit}`];
  }
  return [];
}
