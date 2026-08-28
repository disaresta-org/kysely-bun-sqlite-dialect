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
