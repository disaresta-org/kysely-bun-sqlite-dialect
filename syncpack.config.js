export default {
  sortFirst: [
    "name",
    "description",
    "version",
    "type",
    "private",
    "main",
    "module",
    "exports",
    "types",
    "sideEffects",
    "license",
    "repository",
    "author",
    "keywords",
    "scripts",
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "resolutions",
  ],
  sortAz: [],
  versionGroups: [
    // A peer range is a supported floor, so it deliberately sits below the
    // exact version pinned in devDependencies for testing.
    {
      label: "peer ranges are floors, not pins",
      dependencyTypes: ["peer"],
      dependencies: ["kysely"],
      packages: ["**"],
      isIgnored: true,
    },
  ],
  semverGroups: [
    // Peer ranges stay permissive.
    {
      range: ">=",
      dependencyTypes: ["peer"],
      dependencies: ["**"],
      packages: ["**"],
    },
    // Everything else is pinned exactly.
    {
      range: "",
      dependencyTypes: ["**"],
      dependencies: ["**"],
      packages: ["**"],
    },
  ],
};
